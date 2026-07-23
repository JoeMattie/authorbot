/**
 * Project-scoped browser state shared by collaboration islands.
 *
 * This is intentionally the vanilla Zustand store: Authorbot remains a
 * framework-free custom-element site. Existing islands can continue using
 * CollabApi while they are migrated one at a time; the chapter activity rail
 * is the first consumer. Nothing in this store is persisted, which keeps
 * credentials and future lease tokens out of browser storage.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  CollabApi,
  type Annotation,
  type ApiResult,
  type ChapterAccepted,
  type ChapterActivity,
  type ChapterHistoryComparison,
  type ChapterHistoryDetail,
  type ChapterHistoryPage,
  type ChapterHistoryRestoreAccepted,
  type ChapterProjection,
  type ChapterRevisionProposalCommand,
  type ChapterSummaryProposalCommand,
  type ChapterSource,
  type CompletedWorkItem,
  type CreateRevisionProposalCommand,
  type CreateAnnotationAccepted,
  type FeedEvent,
  type LeaseRelease,
  type LeaseRecovery,
  type LeaseRenewal,
  type Me,
  type MutationOptions,
  type Operation,
  type OverrideResult,
  type Reply,
  type ReplyAccepted,
  type ReplyWithdrawAccepted,
  type RepositoryDocumentKind,
  type RepositoryDocumentProposalCommand,
  type RepositoryDocumentSource,
  type RevisionProposalAccepted,
  type RevisionProposalDetail,
  type RevisionProposalSummary,
  type RevisionReviewResult,
  type SubmissionAccepted,
  type SubmitBody,
  type TaskBundle,
  type VoteResult,
  type VoteValue,
  type WorkItem,
  type WithdrawAccepted,
} from "./api.js";
import { CollabEvents } from "./events.js";

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectStoreConfig {
  apiBase: string;
  project: string;
}

/** The narrow API seam keeps the store independently testable. */
export interface ProjectStoreApi {
  meResult(): Promise<ApiResult<Me | null>>;
  chapters(): Promise<ApiResult<ChapterProjection[]>>;
  annotations?(chapterId: string): Promise<ApiResult<Annotation[]>>;
  replies?(annotationId: string): Promise<ApiResult<Reply[]>>;
  workItems?(cursor?: string): Promise<
    ApiResult<{ items: WorkItem[]; nextCursor: string | null }>
  >;
  completedWorkItems?(
    cursor?: string,
    limit?: number,
  ): Promise<ApiResult<{ items: CompletedWorkItem[]; nextCursor: string | null }>>;
  revisionProposals?: CollabApi["revisionProposals"];
  revisionProposal?: CollabApi["revisionProposal"];
  repositoryDocumentSource?(
    kind: RepositoryDocumentKind,
    path: string,
  ): Promise<ApiResult<RepositoryDocumentSource>>;
  createRevisionProposal?(
    command: CreateRevisionProposalCommand,
    options?: MutationOptions,
  ): Promise<ApiResult<RevisionProposalAccepted>>;
  reviewRevisionProposal?: CollabApi["reviewRevisionProposal"];
  chapterHistory?: CollabApi["chapterHistory"];
  chapterHistoryRevision?: CollabApi["chapterHistoryRevision"];
  restoreChapterRevision?: CollabApi["restoreChapterRevision"];
  operation?(operationId: string): Promise<Operation | null>;
  eventsUrl?(): string;
  pollEvents?(after: number): Promise<
    ApiResult<{ items: FeedEvent[]; latestId: number }>
  >;
  createAnnotation?: CollabApi["createAnnotation"];
  createReply?: CollabApi["createReply"];
  withdraw?: CollabApi["withdraw"];
  withdrawReply?: CollabApi["withdrawReply"];
  castVote?: CollabApi["castVote"];
  clearVote?: CollabApi["clearVote"];
  promoteToWork?: CollabApi["promoteToWork"];
  rejectSuggestion?: CollabApi["rejectSuggestion"];
  claim?: CollabApi["claim"];
  recoverLease?: CollabApi["recoverLease"];
  renewLease?: CollabApi["renewLease"];
  releaseLease?: CollabApi["releaseLease"];
  submitWork?: CollabApi["submitWork"];
  chapterSource?: CollabApi["chapterSource"];
  createChapter?: CollabApi["createChapter"];
  reviseChapter?: CollabApi["reviseChapter"];
  publishChapter?: CollabApi["publishChapter"];
  unpublishChapter?: CollabApi["unpublishChapter"];
}

export type StoreActionFailureKind = "rejected" | "ambiguous";

export type StoreActionResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: StoreActionFailureKind;
      status: number;
      message: string;
      problem?: Record<string, unknown>;
    };

export type AnnotationCommand = Parameters<CollabApi["createAnnotation"]>[1];
export type ChapterCreateCommand = Parameters<CollabApi["createChapter"]>[0];
export type ChapterReviseCommand = Parameters<CollabApi["reviseChapter"]>[0];
export type WorkSubmission = Omit<SubmitBody, "leaseId" | "leaseToken">;
export type SafeTaskBundle = Omit<TaskBundle, "lease"> & {
  lease: Omit<TaskBundle["lease"], "token" | "tokenRedacted">;
};

export interface ConnectionState {
  transport: "none" | "sse" | "poll";
  status: "idle" | "connecting" | "live" | "recovering" | "offline";
  cursor: number;
  lastError: string | null;
}

export type MutationPhase = "optimistic" | "accepted" | "ambiguous";

export interface PendingMutation {
  id: string;
  kind: string;
  phase: MutationPhase;
  idempotencyKey: string;
  /** Stable logical-command identity used to retain a key across UI retries. */
  fingerprint: string;
  chapterId: string | null;
  annotationId: string | null;
  workItemId: string | null;
  activityDelta: Readonly<Partial<Record<keyof ChapterActivity, number>>>;
  activityBaseline: Readonly<Partial<Record<keyof ChapterActivity, number>>>;
}

interface OperationContext {
  kind: string;
  chapterId: string | null;
  workItemId: string | null;
  /** The exact thread to refresh when an asynchronous reply write settles. */
  replyAnnotationId?: string;
  annotationId?: string;
  mutationId?: string;
  fingerprint?: string;
  refreshWork?: boolean;
  revisionProposalId?: string;
  settlementAttempts?: number;
}

export interface ProjectStoreState {
  /** Stable identity for this page-scoped store. */
  project: Readonly<ProjectStoreConfig>;
  session: Me | null;
  sessionStatus: ResourceStatus;
  sessionError: string | null;
  chaptersById: Readonly<Record<string, ChapterProjection>>;
  chapterIds: readonly string[];
  chaptersStatus: ResourceStatus;
  chaptersError: string | null;
  annotationsById: Readonly<Record<string, Annotation>>;
  annotationIdsByChapter: Readonly<Record<string, readonly string[]>>;
  annotationStatusByChapter: Readonly<Record<string, ResourceStatus>>;
  annotationErrorByChapter: Readonly<Record<string, string | null>>;
  repliesById: Readonly<Record<string, Reply>>;
  replyIdsByAnnotation: Readonly<Record<string, readonly string[]>>;
  replyStatusByAnnotation: Readonly<Record<string, ResourceStatus>>;
  replyErrorByAnnotation: Readonly<Record<string, string | null>>;
  replyErrorStatusByAnnotation: Readonly<Record<string, number | null>>;
  workItemsById: Readonly<Record<string, WorkItem>>;
  workItemIds: readonly string[];
  workItemsStatus: ResourceStatus;
  workItemsError: string | null;
  completedWorkItemsById: Readonly<Record<string, CompletedWorkItem>>;
  completedWorkItemIds: readonly string[];
  completedWorkItemsStatus: ResourceStatus;
  completedWorkItemsError: string | null;
  completedWorkItemsNextCursor: string | null;
  revisionProposalsById: Readonly<Record<string, RevisionProposalSummary>>;
  revisionProposalIds: readonly string[];
  revisionProposalsStatus: ResourceStatus;
  revisionProposalsError: string | null;
  revisionProposalDetailStatusById: Readonly<Record<string, ResourceStatus>>;
  revisionProposalDetailErrorById: Readonly<Record<string, string | null>>;
  chapterHistoryByChapter: Readonly<Record<string, ChapterHistoryPage>>;
  chapterHistoryStatusByChapter: Readonly<Record<string, ResourceStatus>>;
  chapterHistoryErrorByChapter: Readonly<Record<string, string | null>>;
  chapterHistoryDetailByKey: Readonly<Record<string, ChapterHistoryDetail>>;
  chapterHistoryDetailStatusByKey: Readonly<Record<string, ResourceStatus>>;
  chapterHistoryDetailErrorByKey: Readonly<Record<string, string | null>>;
  operationsById: Readonly<Record<string, Operation>>;
  pendingMutations: Readonly<Record<string, PendingMutation>>;
  connection: ConnectionState;
  activeClaimsByWorkItem: Readonly<Record<string, SafeTaskBundle>>;
  claimInvalidationsByWorkItem: Readonly<Record<string, string>>;
  /**
   * Accepted submissions learned from either HTTP or this tab's correlated
   * feed event. This lets an editor settle even when the accepted response was
   * lost after the server consumed its lease.
   */
  submissionAcceptancesByWorkItem: Readonly<Record<string, SubmissionAccepted>>;
  ensureSession(): Promise<void>;
  refreshSession(credentialChanged?: boolean): Promise<void>;
  ensureChapters(): Promise<void>;
  refreshChapters(): Promise<void>;
  ensureAnnotations(chapterId: string): Promise<void>;
  refreshAnnotations(chapterId: string): Promise<void>;
  ensureReplies(annotationId: string): Promise<void>;
  refreshReplies(annotationId: string): Promise<void>;
  ensureWorkItems(): Promise<void>;
  refreshWorkItems(): Promise<void>;
  ensureCompletedWorkItems(): Promise<void>;
  refreshCompletedWorkItems(): Promise<void>;
  loadMoreCompletedWorkItems(): Promise<void>;
  ensureRevisionProposals(): Promise<void>;
  refreshRevisionProposals(): Promise<void>;
  ensureRevisionProposal(proposalId: string): Promise<void>;
  refreshRevisionProposal(proposalId: string): Promise<void>;
  ensureChapterHistory(chapterId: string): Promise<void>;
  refreshChapterHistory(chapterId: string): Promise<void>;
  ensureChapterHistoryRevision(
    chapterId: string,
    revision: number,
    compare: ChapterHistoryComparison,
  ): Promise<void>;
  refreshChapterHistoryRevision(
    chapterId: string,
    revision: number,
    compare: ChapterHistoryComparison,
  ): Promise<void>;
  refreshOperation(operationId: string): Promise<Operation | null>;
  /**
   * Retain the one project feed. The returned release function is idempotent;
   * the transport closes after the final interested island disconnects.
   */
  retainConnection(): () => void;
  reconcileEvent(event: FeedEvent): void;
  createAnnotation(
    chapterId: string,
    command: AnnotationCommand,
  ): Promise<StoreActionResult<CreateAnnotationAccepted>>;
  createReply(
    annotationId: string,
    body: string,
    parentReplyId?: string,
  ): Promise<StoreActionResult<ReplyAccepted>>;
  withdrawAnnotation(annotationId: string): Promise<StoreActionResult<WithdrawAccepted>>;
  withdrawReply(
    annotationId: string,
    replyId: string,
  ): Promise<StoreActionResult<ReplyWithdrawAccepted>>;
  setVote(annotationId: string, value: VoteValue | null): Promise<StoreActionResult<VoteResult>>;
  promoteAnnotation(annotationId: string): Promise<StoreActionResult<OverrideResult>>;
  rejectAnnotation(annotationId: string, reason: string): Promise<StoreActionResult<OverrideResult>>;
  reviewRevision(
    proposalId: string,
    decision: "approve" | "reject",
    reason?: string,
  ): Promise<StoreActionResult<RevisionReviewResult>>;
  restoreChapterHistory(
    chapterId: string,
    revision: number,
  ): Promise<StoreActionResult<ChapterHistoryRestoreAccepted>>;
  claimWork(workItemId: string): Promise<StoreActionResult<SafeTaskBundle>>;
  recoverClaim(bundle: SafeTaskBundle): Promise<StoreActionResult<SafeTaskBundle>>;
  /** Drop a local capability without sending a server mutation. */
  forgetClaim(workItemId: string): void;
  renewClaim(workItemId: string): Promise<StoreActionResult<LeaseRenewal>>;
  releaseClaim(workItemId: string): Promise<StoreActionResult<LeaseRelease>>;
  submitClaim(
    workItemId: string,
    command: WorkSubmission,
  ): Promise<StoreActionResult<SubmissionAccepted>>;
  readChapterSource(chapterId: string): Promise<StoreActionResult<ChapterSource>>;
  readRepositoryDocument(
    kind: RepositoryDocumentKind,
    path: string,
  ): Promise<StoreActionResult<RepositoryDocumentSource>>;
  proposeRepositoryDocument(
    command: RepositoryDocumentProposalCommand,
  ): Promise<StoreActionResult<RevisionProposalAccepted>>;
  proposeChapterRevision(
    command: ChapterRevisionProposalCommand,
  ): Promise<StoreActionResult<RevisionProposalAccepted>>;
  proposeChapterSummary(
    command: ChapterSummaryProposalCommand,
  ): Promise<StoreActionResult<RevisionProposalAccepted>>;
  createChapter(command: ChapterCreateCommand): Promise<StoreActionResult<ChapterAccepted>>;
  reviseChapter(command: ChapterReviseCommand): Promise<StoreActionResult<ChapterAccepted>>;
  setChapterPublication(
    chapterId: string,
    published: boolean,
  ): Promise<StoreActionResult<ChapterAccepted>>;
}

export type ProjectStore = StoreApi<ProjectStoreState>;

const CONNECTION_RETRY_BASE_MS = 500;
const CONNECTION_RETRY_MAX_MS = 30_000;
const MAX_WORK_ITEM_PAGES = 10;
const COMPLETED_WORK_ITEM_PAGE_SIZE = 20;
const MAX_REVISION_PROPOSAL_PAGES = 10;
const MAX_CHAPTER_HISTORY_ROWS = 50;
const MAX_CHAPTER_HISTORY_DETAILS = 8;
const MAX_OPERATION_SETTLEMENT_RETRIES = 4;

/** Planning writes live in the lazy store chunk, not the 35 KB reader entry. */
class ProjectStoreApiClient extends CollabApi implements ProjectStoreApi {
  async repositoryDocumentSource(
    kind: RepositoryDocumentKind,
    path: string,
  ): Promise<ApiResult<RepositoryDocumentSource>> {
    const query = new URLSearchParams({ kind, path });
    return this.jsonResult<RepositoryDocumentSource>(
      (async () =>
        this.get(this.projectUrl(`/repository-documents/source?${query.toString()}`)))(),
      [200],
    );
  }

  async createRevisionProposal(
    command: CreateRevisionProposalCommand,
    options?: MutationOptions,
  ): Promise<ApiResult<RevisionProposalAccepted>> {
    return this.jsonResult<RevisionProposalAccepted>(
      this.post(this.projectUrl("/revision-proposals"), command, options),
      [201, 202],
      { mutation: true, subject: "revision proposal" },
    );
  }
}

/** Stable cache key shared by the history panel and the project store. */
export function chapterHistoryDetailKey(
  chapterId: string,
  revision: number,
  compare: ChapterHistoryComparison,
): string {
  return JSON.stringify([chapterId, revision, compare]);
}

export function createProjectStore(
  config: ProjectStoreConfig,
  api: ProjectStoreApi = new ProjectStoreApiClient(config.apiBase, config.project),
): ProjectStore {
  let sessionRequest: Promise<void> | null = null;
  let chaptersRequest: Promise<void> | null = null;
  let chaptersQueuedRequest: Promise<void> | null = null;
  const annotationRequests = new Map<string, Promise<void>>();
  const annotationQueuedRequests = new Map<string, Promise<void>>();
  const replyRequests = new Map<string, Promise<void>>();
  const replyQueuedRequests = new Map<string, Promise<void>>();
  let workItemsRequest: Promise<void> | null = null;
  let workItemsQueuedRequest: Promise<void> | null = null;
  let completedWorkItemsRequest: Promise<void> | null = null;
  let completedWorkItemsQueuedRequest: Promise<void> | null = null;
  let revisionProposalsRequest: Promise<void> | null = null;
  let revisionProposalsQueuedRequest: Promise<void> | null = null;
  const revisionProposalRequests = new Map<string, Promise<void>>();
  const revisionProposalQueuedRequests = new Map<string, Promise<void>>();
  const chapterHistoryRequests = new Map<string, Promise<void>>();
  const chapterHistoryQueuedRequests = new Map<string, Promise<void>>();
  const chapterHistoryDetailRequests = new Map<string, Promise<void>>();
  const chapterHistoryDetailQueuedRequests = new Map<string, Promise<void>>();
  let connectionUsers = 0;
  let events: CollabEvents | null = null;
  let startingEvents: Promise<void> | null = null;
  let recoveryRequest: Promise<boolean> | null = null;
  let connectionRetryTimer: number | undefined;
  let connectionFailures = 0;
  let authoritativeReady = false;
  let transportConnected = false;
  let authorizationGeneration = 0;
  let authoritativeChapters: Readonly<Record<string, ChapterProjection>> = {};
  const leaseSecrets = new Map<string, { leaseId: string; token: string }>();
  const leaseRecoveryCorrelations = new Map<string, Set<string>>();
  const localSubmissionCommands = new Map<
    string,
    {
      correlationId: string;
      fingerprint: string;
      submissionId?: string;
      operationId?: string;
      terminalEventSeen?: boolean;
    }
  >();
  const retainedMutationKeys = new Map<string, string>();
  const operationContexts = new Map<string, OperationContext>();
  let store!: ProjectStore;

  const clearConnectionRetry = (): void => {
    if (connectionRetryTimer !== undefined) {
      globalThis.clearTimeout(connectionRetryTimer);
      connectionRetryTimer = undefined;
    }
  };

  const scheduleConnectionRetry = (retry: () => void): void => {
    if (connectionUsers === 0 || connectionRetryTimer !== undefined) {
      return;
    }
    connectionFailures += 1;
    const exponent = Math.min(connectionFailures - 1, 20);
    const delay = Math.min(
      CONNECTION_RETRY_BASE_MS * 2 ** exponent,
      CONNECTION_RETRY_MAX_MS,
    );
    connectionRetryTimer = globalThis.setTimeout(() => {
      connectionRetryTimer = undefined;
      if (connectionUsers > 0) {
        retry();
      }
    }, delay) as unknown as number;
  };

  const mutationId = (): string => {
    try {
      return crypto.randomUUID();
    } catch {
      return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  };

  const commandFingerprint = (...parts: unknown[]): string => JSON.stringify(parts);

  const retainedKeyFor = (fingerprint: string): string => {
    const retained = retainedMutationKeys.get(fingerprint);
    if (retained !== undefined) {
      for (const mutation of Object.values(store.getState().pendingMutations)) {
        if (mutation.fingerprint === fingerprint) removePendingMutation(mutation.id);
      }
      return retained;
    }
    const created = mutationId();
    retainedMutationKeys.set(fingerprint, created);
    return created;
  };

  const settleCommand = (fingerprint: string): void => {
    retainedMutationKeys.delete(fingerprint);
  };

  const credentialChanged = <T>(): StoreActionResult<T> => ({
    ok: false,
    kind: "rejected",
    status: 409,
    message: "the signed-in credential changed while this request was in flight",
  });

  const sessionFingerprint = (session: Me | null): string =>
    session === null
      ? "signed-out"
      : JSON.stringify([
          session.actor.id,
          [...session.scopes].sort(),
          [...(session.memberships ?? [])].map((membership) => membership.role).sort(),
        ]);

  const purgePermissionScopedState = (): {
    chapters: boolean;
    annotations: string[];
    replies: string[];
    work: boolean;
    completedWork: boolean;
    revisions: boolean;
    revisionDetails: string[];
    history: string[];
    historyDetails: Array<{
      chapterId: string;
      revision: number;
      compare: ChapterHistoryComparison;
    }>;
    connection: boolean;
  } => {
    const state = store.getState();
    const loaded = {
      chapters: state.chaptersStatus !== "idle",
      annotations: Object.keys(state.annotationStatusByChapter),
      replies: Object.keys(state.replyStatusByAnnotation),
      work: state.workItemsStatus !== "idle",
      completedWork: state.completedWorkItemsStatus !== "idle",
      revisions: state.revisionProposalsStatus !== "idle",
      revisionDetails: Object.keys(state.revisionProposalDetailStatusById),
      history: Object.keys(state.chapterHistoryStatusByChapter),
      historyDetails: Object.values(state.chapterHistoryDetailByKey).map((detail) => ({
        chapterId: detail.chapterId,
        revision: detail.selected.revision,
        compare: detail.compare,
      })),
      connection: connectionUsers > 0,
    };
    const claimInvalidationsByWorkItem = {
      ...state.claimInvalidationsByWorkItem,
    };
    for (const workItemId of Object.keys(state.activeClaimsByWorkItem)) {
      claimInvalidationsByWorkItem[workItemId] =
        "Your signed-in credential changed, so this lease can no longer be used here.";
    }
    authorizationGeneration += 1;
    chaptersQueuedRequest = null;
    annotationQueuedRequests.clear();
    replyQueuedRequests.clear();
    workItemsQueuedRequest = null;
    completedWorkItemsQueuedRequest = null;
    revisionProposalsQueuedRequest = null;
    revisionProposalQueuedRequests.clear();
    chapterHistoryQueuedRequests.clear();
    chapterHistoryDetailQueuedRequests.clear();
    clearConnectionRetry();
    authoritativeReady = false;
    transportConnected = false;
    events?.stop();
    events = null;
    leaseSecrets.clear();
    leaseRecoveryCorrelations.clear();
    localSubmissionCommands.clear();
    retainedMutationKeys.clear();
    operationContexts.clear();
    authoritativeChapters = {};
    store.setState({
      chaptersById: {},
      chapterIds: [],
      chaptersStatus: "idle",
      chaptersError: null,
      annotationsById: {},
      annotationIdsByChapter: {},
      annotationStatusByChapter: {},
      annotationErrorByChapter: {},
      repliesById: {},
      replyIdsByAnnotation: {},
      replyStatusByAnnotation: {},
      replyErrorByAnnotation: {},
      replyErrorStatusByAnnotation: {},
      workItemsById: {},
      workItemIds: [],
      workItemsStatus: "idle",
      workItemsError: null,
      completedWorkItemsById: {},
      completedWorkItemIds: [],
      completedWorkItemsStatus: "idle",
      completedWorkItemsError: null,
      completedWorkItemsNextCursor: null,
      revisionProposalsById: {},
      revisionProposalIds: [],
      revisionProposalsStatus: "idle",
      revisionProposalsError: null,
      revisionProposalDetailStatusById: {},
      revisionProposalDetailErrorById: {},
      chapterHistoryByChapter: {},
      chapterHistoryStatusByChapter: {},
      chapterHistoryErrorByChapter: {},
      chapterHistoryDetailByKey: {},
      chapterHistoryDetailStatusByKey: {},
      chapterHistoryDetailErrorByKey: {},
      operationsById: {},
      pendingMutations: {},
      activeClaimsByWorkItem: {},
      claimInvalidationsByWorkItem,
      submissionAcceptancesByWorkItem: {},
      connection: {
        transport: "none",
        status: connectionUsers > 0 ? "connecting" : "idle",
        cursor: 0,
        lastError: null,
      },
    });
    return loaded;
  };

  const actionFailure = <T>(result: Extract<ApiResult<T>, { ok: false }>): StoreActionResult<never> => ({
    ok: false,
    kind:
      result.ambiguous === true || result.status === 0 || result.status >= 500
        ? "ambiguous"
        : "rejected",
    status: result.status,
    message: result.message,
    ...(result.problem === undefined ? {} : { problem: result.problem }),
  });

  const unsupported = (name: string): StoreActionResult<never> => ({
    ok: false,
    kind: "rejected",
    status: 501,
    message: `${name} is unavailable in this deployment`,
  });

  const annotationActivity = (
    annotation: Pick<Annotation, "kind" | "scope">,
    amount: number,
  ): Partial<Record<keyof ChapterActivity, number>> => {
    if (annotation.kind === "suggestion") {
      return { openSuggestions: amount };
    }
    return annotation.scope === "chapter"
      ? { openChapterComments: amount }
      : { openBlockComments: amount };
  };

  const visibleReplyCount = (annotationId: string): number =>
    (store.getState().replyIdsByAnnotation[annotationId] ?? []).filter((replyId) => {
      const status = store.getState().repliesById[replyId]?.status;
      // A pending reply is part of the store's accepted optimistic projection
      // until the operation event replaces it with the authoritative row.
      return status === "open" || status === "pending_git";
    }).length;

  const effectiveChapters = (
    pending: Readonly<Record<string, PendingMutation>>,
  ): Readonly<Record<string, ChapterProjection>> => {
    const projected: Record<string, ChapterProjection> = {};
    for (const [chapterId, chapter] of Object.entries(authoritativeChapters)) {
      projected[chapterId] = chapter;
    }
    for (const mutation of Object.values(pending)) {
      if (mutation.chapterId === null || mutation.phase === "ambiguous") continue;
      const chapter = projected[mutation.chapterId];
      if (chapter === undefined) continue;
      const activity: ChapterActivity = { ...(chapter.activity ?? {}) };
      for (const [key, amount] of Object.entries(mutation.activityDelta) as Array<
        [keyof ChapterActivity, number]
      >) {
        const before = activity[key] ?? 0;
        const baseline = mutation.activityBaseline[key] ?? before;
        const target = Math.max(0, baseline + amount);
        activity[key] = amount >= 0 ? Math.max(before, target) : Math.min(before, target);
      }
      projected[mutation.chapterId] = { ...chapter, activity };
    }
    return projected;
  };

  const setPendingMutations = (
    pendingMutations: Readonly<Record<string, PendingMutation>>,
  ): void => {
    store.setState({
      pendingMutations,
      chaptersById: effectiveChapters(pendingMutations),
    });
  };

  const addPendingMutation = (
    mutation: Omit<PendingMutation, "activityBaseline">,
  ): void => {
    const activity =
      mutation.chapterId === null
        ? undefined
        : store.getState().chaptersById[mutation.chapterId]?.activity;
    const activityBaseline: Partial<Record<keyof ChapterActivity, number>> = {};
    for (const key of Object.keys(mutation.activityDelta) as Array<keyof ChapterActivity>) {
      activityBaseline[key] = activity?.[key] ?? 0;
    }
    setPendingMutations({
      ...store.getState().pendingMutations,
      [mutation.id]: { ...mutation, activityBaseline },
    });
  };

  const updatePendingMutation = (
    id: string,
    phase: MutationPhase,
  ): void => {
    const pending = { ...store.getState().pendingMutations };
    const current = pending[id];
    if (current === undefined) return;
    // Later optimistic mutations captured a baseline that includes this one.
    // Once an ambiguous response rolls this projection back, shift those
    // baselines too so the surviving overlays still represent one delta each.
    if (phase === "ambiguous" && current.phase !== "ambiguous") {
      let afterCurrent = false;
      for (const [candidateId, candidate] of Object.entries(pending)) {
        if (candidateId === id) {
          afterCurrent = true;
          continue;
        }
        if (!afterCurrent || candidate.chapterId !== current.chapterId) continue;
        const activityBaseline = { ...candidate.activityBaseline };
        for (const [key, amount] of Object.entries(current.activityDelta) as Array<
          [keyof ChapterActivity, number]
        >) {
          if (activityBaseline[key] !== undefined) {
            activityBaseline[key] = Math.max(0, (activityBaseline[key] ?? 0) - amount);
          }
        }
        pending[candidateId] = { ...candidate, activityBaseline };
      }
    }
    pending[id] = { ...current, phase };
    setPendingMutations(pending);
  };

  const updatePendingActivity = (
    id: string,
    activityDelta: Readonly<Partial<Record<keyof ChapterActivity, number>>>,
  ): void => {
    const current = store.getState().pendingMutations[id];
    if (current === undefined) return;
    const activity =
      current.chapterId === null
        ? undefined
        : store.getState().chaptersById[current.chapterId]?.activity;
    const activityBaseline = { ...current.activityBaseline };
    for (const key of Object.keys(activityDelta) as Array<keyof ChapterActivity>) {
      activityBaseline[key] ??= activity?.[key] ?? 0;
    }
    setPendingMutations({
      ...store.getState().pendingMutations,
      [id]: { ...current, activityDelta, activityBaseline },
    });
  };

  const removePendingMutation = (id: string, rebaseFollowing = false): void => {
    const pending = { ...store.getState().pendingMutations };
    const current = pending[id];
    if (rebaseFollowing && current !== undefined && current.phase !== "ambiguous") {
      let afterCurrent = false;
      for (const [candidateId, candidate] of Object.entries(pending)) {
        if (candidateId === id) {
          afterCurrent = true;
          continue;
        }
        if (!afterCurrent || candidate.chapterId !== current.chapterId) continue;
        const activityBaseline = { ...candidate.activityBaseline };
        for (const [key, amount] of Object.entries(current.activityDelta) as Array<
          [keyof ChapterActivity, number]
        >) {
          if (activityBaseline[key] !== undefined) {
            activityBaseline[key] = Math.max(0, (activityBaseline[key] ?? 0) - amount);
          }
        }
        pending[candidateId] = { ...candidate, activityBaseline };
      }
    }
    delete pending[id];
    setPendingMutations(pending);
  };

  const refreshMutationResources = async (
    chapterId: string | null,
    annotationId: string | null,
    refreshWork: boolean,
    revisionProposalId?: string,
  ): Promise<{ attempted: boolean; ok: boolean }> => {
    const jobs: Promise<unknown>[] = [];
    const checks: Array<() => boolean> = [];
    if (chapterId !== null) {
      if (store.getState().annotationStatusByChapter[chapterId] !== undefined) {
        jobs.push(loadAnnotations(chapterId, true));
        checks.push(() => store.getState().annotationStatusByChapter[chapterId] === "ready");
      }
      if (store.getState().chaptersStatus !== "idle") {
        jobs.push(loadChapters(true));
        checks.push(() => store.getState().chaptersStatus === "ready");
      }
    }
    if (
      annotationId !== null &&
      store.getState().replyStatusByAnnotation[annotationId] !== undefined
    ) {
      jobs.push(loadReplies(annotationId, true));
      checks.push(() => store.getState().replyStatusByAnnotation[annotationId] === "ready");
    }
    if (refreshWork && store.getState().workItemsStatus !== "idle") {
      jobs.push(loadWorkItems(true));
      checks.push(() => store.getState().workItemsStatus === "ready");
    }
    if (refreshWork && store.getState().completedWorkItemsStatus !== "idle") {
      jobs.push(loadCompletedWorkItems("refresh"));
      checks.push(() => store.getState().completedWorkItemsStatus === "ready");
    }
    if (revisionProposalId !== undefined) {
      if (store.getState().revisionProposalsStatus !== "idle") {
        jobs.push(loadRevisionProposals(true));
        checks.push(() => store.getState().revisionProposalsStatus === "ready");
      }
      if (store.getState().revisionProposalDetailStatusById[revisionProposalId] !== undefined) {
        jobs.push(loadRevisionProposal(revisionProposalId, true));
        checks.push(
          () =>
            store.getState().revisionProposalDetailStatusById[revisionProposalId] === "ready",
        );
      }
    }
    const results = await Promise.allSettled(jobs);
    return {
      attempted: jobs.length > 0,
      ok:
        results.every((result) => result.status === "fulfilled") &&
        checks.every((check) => check()),
    };
  };

  const settleOperationContext = async (
    operationId: string,
    operation: Operation,
  ): Promise<void> => {
    const completed = operation.state === "committed" || operation.state === "verified";
    const terminal = completed || operation.state === "failed";
    const context = operationContexts.get(operationId);
    if (context === undefined || !terminal) return;
    const generation = authorizationGeneration;

    // Delete before awaiting reads so a duplicate event or a response-race
    // cache lookup cannot settle the same logical command twice.
    operationContexts.delete(operationId);
    const refreshed = await refreshMutationResources(
      context.chapterId,
      context.replyAnnotationId ?? context.annotationId ?? null,
      context.refreshWork === true || context.kind === "submission.apply",
      context.revisionProposalId,
    );
    if (generation !== authorizationGeneration) return;
    if (refreshed.attempted && !refreshed.ok) {
      // A terminal event may arrive during a transient read failure. Keep the
      // context so the next poll/event can retry rather than stranding an
      // accepted overlay and its retained command key forever.
      const settlementAttempts = (context.settlementAttempts ?? 0) + 1;
      const retryContext = { ...context, settlementAttempts };
      operationContexts.set(operationId, retryContext);
      if (settlementAttempts <= MAX_OPERATION_SETTLEMENT_RETRIES) {
        const delay = Math.min(
          CONNECTION_RETRY_BASE_MS * 2 ** (settlementAttempts - 1),
          CONNECTION_RETRY_MAX_MS,
        );
        globalThis.setTimeout(() => {
          if (
            generation === authorizationGeneration &&
            operationContexts.get(operationId) === retryContext
          ) {
            void settleOperationContext(operationId, operation);
          }
        }, delay);
      }
      return;
    }
    if (
      context.mutationId !== undefined &&
      context.fingerprint !== undefined &&
      (!refreshed.attempted || refreshed.ok)
    ) {
      removePendingMutation(context.mutationId, operation.state === "failed");
      settleCommand(context.fingerprint);
    }
  };

  const registerOperationContext = async (
    operationId: string,
    context: OperationContext,
  ): Promise<void> => {
    operationContexts.set(operationId, context);
    // The event feed can observe the committed operation before the HTTP 202
    // response reaches this tab. Consume that cached terminal result now; if
    // its refresh is still in flight, that path will see this context instead.
    const cached = store.getState().operationsById[operationId];
    if (cached !== undefined) {
      await settleOperationContext(operationId, cached);
    }
  };

  const settleAcceptedMutation = async (
    id: string,
    fingerprint: string,
    chapterId: string | null,
    annotationId: string | null,
    refreshWork: boolean,
    deferToOperation = false,
  ): Promise<void> => {
    updatePendingMutation(id, "accepted");
    const refreshed = await refreshMutationResources(chapterId, annotationId, refreshWork);
    // With no loaded projection, the normalized response is already the only
    // visible state. Otherwise only a successful post-command read may retire
    // the overlay; a failed read leaves it available for event/reconnect
    // settlement instead of mutating the server snapshot by hand.
    if (!deferToOperation && (!refreshed.attempted || refreshed.ok)) {
      removePendingMutation(id);
      settleCommand(fingerprint);
    }
  };

  const reconcileAmbiguous = async (
    mutationIdValue: string,
    chapterId: string | null,
    annotationId: string | null,
    refreshWork: boolean,
  ): Promise<void> => {
    updatePendingMutation(mutationIdValue, "ambiguous");
    // Refresh for honest UI, but a generic GET returning old state cannot
    // prove that a response-lost mutation is not still committing. Keep the
    // key until an exact same-key replay or correlated event proves outcome.
    await refreshMutationResources(chapterId, annotationId, refreshWork);
  };

  const loadSession = (force: boolean, credentialChanged = false): Promise<void> => {
    const current = store.getState();
    if (!force && current.sessionStatus === "ready") {
      return Promise.resolve();
    }
    if (sessionRequest !== null) {
      const currentRequest = sessionRequest;
      return force
        ? currentRequest.then(
            () => loadSession(true, credentialChanged),
            () => loadSession(true, credentialChanged),
          )
        : currentRequest;
    }
    store.setState({ sessionStatus: "loading", sessionError: null });
    sessionRequest = (async () => {
      const result = await api.meResult();
      if (result.ok) {
        const changed = credentialChanged ||
          sessionFingerprint(store.getState().session) !== sessionFingerprint(result.value);
        const reload = changed ? purgePermissionScopedState() : null;
        store.setState({
          session: result.value,
          sessionStatus: "ready",
          sessionError: null,
        });
        if (reload !== null) {
          const jobs: Promise<unknown>[] = [];
          if (reload.chapters) jobs.push(loadChapters(true));
          for (const chapterId of reload.annotations) jobs.push(loadAnnotations(chapterId, true));
          for (const annotationId of reload.replies) jobs.push(loadReplies(annotationId, true));
          if (reload.work) jobs.push(loadWorkItems(true));
          if (reload.completedWork) jobs.push(loadCompletedWorkItems("refresh"));
          if (reload.revisions) jobs.push(loadRevisionProposals(true));
          for (const proposalId of reload.revisionDetails) {
            jobs.push(loadRevisionProposal(proposalId, true));
          }
          for (const chapterId of reload.history) {
            jobs.push(loadChapterHistory(chapterId, true));
          }
          for (const detail of reload.historyDetails) {
            jobs.push(
              loadChapterHistoryRevision(
                detail.chapterId,
                detail.revision,
                detail.compare,
                true,
              ),
            );
          }
          await Promise.allSettled(jobs);
          if (reload.connection && connectionUsers > 0) {
            const pendingStart = startingEvents;
            if (pendingStart === null) {
              void startEvents();
            } else {
              const restart = (): void => {
                if (connectionUsers > 0) void startEvents();
              };
              void pendingStart.then(restart, restart);
            }
          }
        }
      } else {
        const reload = store.getState().session !== null
          ? purgePermissionScopedState()
          : null;
        store.setState({
          session: null,
          sessionStatus: "error",
          sessionError: result.message,
        });
        if (reload?.connection === true && connectionUsers > 0) {
          const pendingStart = startingEvents;
          if (pendingStart === null) {
            void startEvents();
          } else {
            const restart = (): void => {
              if (connectionUsers > 0) void startEvents();
            };
            void pendingStart.then(restart, restart);
          }
        }
      }
    })().finally(() => {
      sessionRequest = null;
    });
    return sessionRequest;
  };

  const loadChapters = (force: boolean): Promise<void> => {
    const current = store.getState();
    if (!force && current.chaptersStatus === "ready") {
      return Promise.resolve();
    }
    if (chaptersRequest !== null) {
      const currentRequest = chaptersRequest;
      if (!force) return currentRequest;
      if (chaptersQueuedRequest !== null) return chaptersQueuedRequest;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const refresh = (): Promise<void> => {
        if (chaptersQueuedRequest === queued) chaptersQueuedRequest = null;
        return generation === authorizationGeneration
          ? loadChapters(true)
          : Promise.resolve();
      };
      queued = currentRequest.then(refresh, refresh);
      chaptersQueuedRequest = queued;
      return queued;
    }
    store.setState({ chaptersStatus: "loading", chaptersError: null });
    const generation = authorizationGeneration;
    chaptersRequest = (async () => {
      const result = await api.chapters();
      if (generation !== authorizationGeneration) return;
      if (!result.ok) {
        store.setState({
          chaptersStatus: "error",
          chaptersError: result.message,
        });
        return;
      }
      const chaptersById: Record<string, ChapterProjection> = {};
      for (const chapter of result.value) {
        chaptersById[chapter.id] = chapter;
      }
      authoritativeChapters = chaptersById;
      store.setState({
        chaptersById: effectiveChapters(store.getState().pendingMutations),
        chapterIds: result.value.map((chapter) => chapter.id),
        chaptersStatus: "ready",
        chaptersError: null,
      });
    })().finally(() => {
      chaptersRequest = null;
    });
    return chaptersRequest;
  };

  const loadAnnotations = (chapterId: string, force: boolean): Promise<void> => {
    const current = store.getState();
    if (!force && current.annotationStatusByChapter[chapterId] === "ready") {
      return Promise.resolve();
    }
    const existing = annotationRequests.get(chapterId);
    if (existing !== undefined) {
      if (!force) return existing;
      const pending = annotationQueuedRequests.get(chapterId);
      if (pending !== undefined) return pending;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const refresh = (): Promise<void> => {
        if (annotationQueuedRequests.get(chapterId) === queued) {
          annotationQueuedRequests.delete(chapterId);
        }
        return generation === authorizationGeneration
          ? loadAnnotations(chapterId, true)
          : Promise.resolve();
      };
      queued = existing.then(refresh, refresh);
      annotationQueuedRequests.set(chapterId, queued);
      return queued;
    }
    const read = api.annotations;
    if (read === undefined) {
      return Promise.resolve();
    }
    store.setState({
      annotationStatusByChapter: {
        ...current.annotationStatusByChapter,
        [chapterId]: "loading",
      },
      annotationErrorByChapter: {
        ...current.annotationErrorByChapter,
        [chapterId]: null,
      },
    });
    const generation = authorizationGeneration;
    const request = (async () => {
      const result = await read.call(api, chapterId);
      if (generation !== authorizationGeneration) return;
      const state = store.getState();
      if (!result.ok) {
        store.setState({
          annotationStatusByChapter: {
            ...state.annotationStatusByChapter,
            [chapterId]: "error",
          },
          annotationErrorByChapter: {
            ...state.annotationErrorByChapter,
            [chapterId]: result.message,
          },
        });
        return;
      }
      const annotationsById = { ...state.annotationsById };
      const previousIds = state.annotationIdsByChapter[chapterId] ?? [];
      for (const id of previousIds) {
        delete annotationsById[id];
      }
      for (const annotation of result.value) {
        annotationsById[annotation.id] = annotation;
      }
      store.setState({
        annotationsById,
        annotationIdsByChapter: {
          ...state.annotationIdsByChapter,
          [chapterId]: result.value.map((annotation) => annotation.id),
        },
        annotationStatusByChapter: {
          ...state.annotationStatusByChapter,
          [chapterId]: "ready",
        },
        annotationErrorByChapter: {
          ...state.annotationErrorByChapter,
          [chapterId]: null,
        },
      });
    })().finally(() => {
      annotationRequests.delete(chapterId);
    });
    annotationRequests.set(chapterId, request);
    return request;
  };

  const loadReplies = (annotationId: string, force: boolean): Promise<void> => {
    const current = store.getState();
    if (!force && current.replyStatusByAnnotation[annotationId] === "ready") {
      return Promise.resolve();
    }
    const existing = replyRequests.get(annotationId);
    if (existing !== undefined) {
      if (!force) return existing;
      const pending = replyQueuedRequests.get(annotationId);
      if (pending !== undefined) return pending;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const refresh = (): Promise<void> => {
        if (replyQueuedRequests.get(annotationId) === queued) {
          replyQueuedRequests.delete(annotationId);
        }
        return generation === authorizationGeneration
          ? loadReplies(annotationId, true)
          : Promise.resolve();
      };
      queued = existing.then(refresh, refresh);
      replyQueuedRequests.set(annotationId, queued);
      return queued;
    }
    const read = api.replies;
    if (read === undefined) {
      return Promise.resolve();
    }
    store.setState({
      replyStatusByAnnotation: {
        ...current.replyStatusByAnnotation,
        [annotationId]: "loading",
      },
      replyErrorByAnnotation: {
        ...current.replyErrorByAnnotation,
        [annotationId]: null,
      },
      replyErrorStatusByAnnotation: {
        ...current.replyErrorStatusByAnnotation,
        [annotationId]: null,
      },
    });
    const generation = authorizationGeneration;
    const request = (async () => {
      const result = await read.call(api, annotationId);
      if (generation !== authorizationGeneration) return;
      const state = store.getState();
      if (!result.ok) {
        store.setState({
          replyStatusByAnnotation: {
            ...state.replyStatusByAnnotation,
            [annotationId]: "error",
          },
          replyErrorByAnnotation: {
            ...state.replyErrorByAnnotation,
            [annotationId]: result.message,
          },
          replyErrorStatusByAnnotation: {
            ...state.replyErrorStatusByAnnotation,
            [annotationId]: result.status,
          },
        });
        return;
      }
      const repliesById = { ...state.repliesById };
      for (const id of state.replyIdsByAnnotation[annotationId] ?? []) {
        delete repliesById[id];
      }
      for (const reply of result.value) {
        repliesById[reply.id] = reply;
      }
      store.setState({
        repliesById,
        replyIdsByAnnotation: {
          ...state.replyIdsByAnnotation,
          [annotationId]: result.value.map((reply) => reply.id),
        },
        replyStatusByAnnotation: {
          ...state.replyStatusByAnnotation,
          [annotationId]: "ready",
        },
        replyErrorByAnnotation: {
          ...state.replyErrorByAnnotation,
          [annotationId]: null,
        },
        replyErrorStatusByAnnotation: {
          ...state.replyErrorStatusByAnnotation,
          [annotationId]: null,
        },
      });
    })().finally(() => {
      replyRequests.delete(annotationId);
    });
    replyRequests.set(annotationId, request);
    return request;
  };

  const loadWorkItems = (force: boolean): Promise<void> => {
    const current = store.getState();
    if (!force && current.workItemsStatus === "ready") {
      return Promise.resolve();
    }
    if (workItemsRequest !== null) {
      const currentRequest = workItemsRequest;
      if (!force) return currentRequest;
      if (workItemsQueuedRequest !== null) return workItemsQueuedRequest;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const refresh = (): Promise<void> => {
        if (workItemsQueuedRequest === queued) workItemsQueuedRequest = null;
        return generation === authorizationGeneration
          ? loadWorkItems(true)
          : Promise.resolve();
      };
      queued = currentRequest.then(refresh, refresh);
      workItemsQueuedRequest = queued;
      return queued;
    }
    const read = api.workItems;
    if (read === undefined) {
      return Promise.resolve();
    }
    store.setState({ workItemsStatus: "loading", workItemsError: null });
    const generation = authorizationGeneration;
    workItemsRequest = (async () => {
      const items: WorkItem[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < MAX_WORK_ITEM_PAGES; page += 1) {
        const result = await read.call(api, cursor);
        if (generation !== authorizationGeneration) return;
        if (!result.ok) {
          store.setState({ workItemsStatus: "error", workItemsError: result.message });
          return;
        }
        items.push(...result.value.items);
        const next = result.value.nextCursor;
        if (next === null) {
          complete = true;
          break;
        }
        if (seen.has(next)) {
          store.setState({
            workItemsStatus: "error",
            workItemsError: "work queue pagination returned a repeated cursor",
          });
          return;
        }
        seen.add(next);
        cursor = next;
      }
      if (!complete) {
        store.setState({
          workItemsStatus: "error",
          workItemsError: `work queue exceeded ${MAX_WORK_ITEM_PAGES} pages`,
        });
        return;
      }
      const workItemsById: Record<string, WorkItem> = {};
      for (const item of items) {
        workItemsById[item.id] = item;
      }
      const workItemIds = items.map((item) => item.id);
      // The server queue intentionally lists only ready work. If a claim
      // committed but both same-key responses were lost, its authoritative
      // refresh omits the item before the browser has learned the lease id.
      // Preserve that one local row as a retry affordance until replaying the
      // retained key yields the redacted bundle and recovery can rotate the
      // token. No other optimistic mutation is allowed to shadow the queue.
      const state = store.getState();
      for (const mutation of Object.values(state.pendingMutations)) {
        if (
          mutation.kind !== "work.claim" ||
          mutation.phase !== "ambiguous" ||
          mutation.workItemId === null ||
          workItemsById[mutation.workItemId] !== undefined
        ) {
          continue;
        }
        const retained = state.workItemsById[mutation.workItemId];
        if (retained !== undefined) {
          workItemsById[retained.id] = retained;
          workItemIds.push(retained.id);
        }
      }
      store.setState({
        workItemsById,
        workItemIds,
        workItemsStatus: "ready",
        workItemsError: null,
      });
    })().finally(() => {
      workItemsRequest = null;
    });
    return workItemsRequest;
  };

  /**
   * Load exactly one completed-Work page. Unlike the live queue, history is
   * intentionally user-paged so a long-running book never pulls its entire
   * archive into one Worker invocation or browser render.
   */
  const loadCompletedWorkItems = (
    mode: "ensure" | "refresh" | "more",
  ): Promise<void> => {
    const current = store.getState();
    if (mode === "ensure" && current.completedWorkItemsStatus === "ready") {
      return Promise.resolve();
    }
    if (mode === "more" && current.completedWorkItemsNextCursor === null) {
      return Promise.resolve();
    }
    if (completedWorkItemsRequest !== null) {
      const active = completedWorkItemsRequest;
      if (mode === "ensure") return active;
      if (completedWorkItemsQueuedRequest !== null) return completedWorkItemsQueuedRequest;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const next = (): Promise<void> => {
        if (completedWorkItemsQueuedRequest === queued) {
          completedWorkItemsQueuedRequest = null;
        }
        return generation === authorizationGeneration
          ? loadCompletedWorkItems(mode)
          : Promise.resolve();
      };
      queued = active.then(next, next);
      completedWorkItemsQueuedRequest = queued;
      return queued;
    }

    const read = api.completedWorkItems;
    if (read === undefined) {
      store.setState({
        completedWorkItemsById: {},
        completedWorkItemIds: [],
        completedWorkItemsStatus: "ready",
        completedWorkItemsError: null,
        completedWorkItemsNextCursor: null,
      });
      return Promise.resolve();
    }

    const cursor = mode === "more"
      ? (current.completedWorkItemsNextCursor ?? undefined)
      : undefined;
    store.setState({
      completedWorkItemsStatus: "loading",
      completedWorkItemsError: null,
    });
    const generation = authorizationGeneration;
    completedWorkItemsRequest = (async () => {
      const result = await read.call(api, cursor, COMPLETED_WORK_ITEM_PAGE_SIZE);
      if (generation !== authorizationGeneration) return;
      if (!result.ok) {
        store.setState({
          completedWorkItemsStatus: "error",
          completedWorkItemsError: result.message,
        });
        return;
      }
      if (cursor !== undefined && result.value.nextCursor === cursor) {
        store.setState({
          completedWorkItemsStatus: "error",
          completedWorkItemsError: "completed Work pagination returned a repeated cursor",
        });
        return;
      }

      const before = store.getState();
      const completedWorkItemsById =
        mode === "more" ? { ...before.completedWorkItemsById } : {};
      const completedWorkItemIds = mode === "more"
        ? [...before.completedWorkItemIds]
        : [];
      const seen = new Set(completedWorkItemIds);
      for (const item of result.value.items) {
        completedWorkItemsById[item.id] = item;
        if (!seen.has(item.id)) {
          completedWorkItemIds.push(item.id);
          seen.add(item.id);
        }
      }
      store.setState({
        completedWorkItemsById,
        completedWorkItemIds,
        completedWorkItemsStatus: "ready",
        completedWorkItemsError: null,
        completedWorkItemsNextCursor: result.value.nextCursor,
      });
    })().finally(() => {
      completedWorkItemsRequest = null;
    });
    return completedWorkItemsRequest;
  };

  const loadRevisionProposals = (force: boolean): Promise<void> => {
    const current = store.getState();
    if (!force && current.revisionProposalsStatus === "ready") {
      return Promise.resolve();
    }
    if (revisionProposalsRequest !== null) {
      const currentRequest = revisionProposalsRequest;
      if (!force) return currentRequest;
      if (revisionProposalsQueuedRequest !== null) return revisionProposalsQueuedRequest;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const refresh = (): Promise<void> => {
        if (revisionProposalsQueuedRequest === queued) revisionProposalsQueuedRequest = null;
        return generation === authorizationGeneration
          ? loadRevisionProposals(true)
          : Promise.resolve();
      };
      queued = currentRequest.then(refresh, refresh);
      revisionProposalsQueuedRequest = queued;
      return queued;
    }
    const read = api.revisionProposals;
    if (read === undefined) {
      store.setState({
        revisionProposalsStatus: "error",
        revisionProposalsError: "revision review is unavailable in this deployment",
      });
      return Promise.resolve();
    }
    store.setState({ revisionProposalsStatus: "loading", revisionProposalsError: null });
    const generation = authorizationGeneration;
    revisionProposalsRequest = (async () => {
      const items: RevisionProposalSummary[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < MAX_REVISION_PROPOSAL_PAGES; page += 1) {
        const result = await read.call(api, cursor);
        if (generation !== authorizationGeneration) return;
        if (!result.ok) {
          store.setState({
            revisionProposalsStatus: "error",
            revisionProposalsError: result.message,
          });
          return;
        }
        items.push(...result.value.items);
        const next = result.value.nextCursor;
        if (next === null) {
          complete = true;
          break;
        }
        if (seen.has(next)) {
          store.setState({
            revisionProposalsStatus: "error",
            revisionProposalsError: "revision queue pagination returned a repeated cursor",
          });
          return;
        }
        seen.add(next);
        cursor = next;
      }
      if (!complete) {
        store.setState({
          revisionProposalsStatus: "error",
          revisionProposalsError:
            `revision queue exceeded ${MAX_REVISION_PROPOSAL_PAGES} pages`,
        });
        return;
      }
      const previous = store.getState().revisionProposalsById;
      const revisionProposalsById: Record<string, RevisionProposalSummary> = {};
      for (const item of items) {
        // Preserve an already-loaded detail snapshot while refreshing its
        // authoritative summary/status from the bounded queue read.
        revisionProposalsById[item.id] = { ...previous[item.id], ...item };
      }
      store.setState({
        revisionProposalsById,
        revisionProposalIds: items.map((item) => item.id),
        revisionProposalsStatus: "ready",
        revisionProposalsError: null,
      });
    })().finally(() => {
      revisionProposalsRequest = null;
    });
    return revisionProposalsRequest;
  };

  const loadRevisionProposal = (proposalId: string, force: boolean): Promise<void> => {
    const state = store.getState();
    if (!force && state.revisionProposalDetailStatusById[proposalId] === "ready") {
      return Promise.resolve();
    }
    const active = revisionProposalRequests.get(proposalId);
    if (active !== undefined) {
      if (!force) return active;
      const queuedActive = revisionProposalQueuedRequests.get(proposalId);
      if (queuedActive !== undefined) return queuedActive;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const refresh = (): Promise<void> => {
        if (revisionProposalQueuedRequests.get(proposalId) === queued) {
          revisionProposalQueuedRequests.delete(proposalId);
        }
        return generation === authorizationGeneration
          ? loadRevisionProposal(proposalId, true)
          : Promise.resolve();
      };
      queued = active.then(refresh, refresh);
      revisionProposalQueuedRequests.set(proposalId, queued);
      return queued;
    }
    const read = api.revisionProposal;
    if (read === undefined) {
      store.setState({
        revisionProposalDetailStatusById: {
          ...state.revisionProposalDetailStatusById,
          [proposalId]: "error",
        },
        revisionProposalDetailErrorById: {
          ...state.revisionProposalDetailErrorById,
          [proposalId]: "revision review is unavailable in this deployment",
        },
      });
      return Promise.resolve();
    }
    store.setState({
      revisionProposalDetailStatusById: {
        ...state.revisionProposalDetailStatusById,
        [proposalId]: "loading",
      },
      revisionProposalDetailErrorById: {
        ...state.revisionProposalDetailErrorById,
        [proposalId]: null,
      },
    });
    const generation = authorizationGeneration;
    const request = (async () => {
      const result = await read.call(api, proposalId);
      if (generation !== authorizationGeneration) return;
      const current = store.getState();
      if (!result.ok) {
        store.setState({
          revisionProposalDetailStatusById: {
            ...current.revisionProposalDetailStatusById,
            [proposalId]: "error",
          },
          revisionProposalDetailErrorById: {
            ...current.revisionProposalDetailErrorById,
            [proposalId]: result.message,
          },
        });
        return;
      }
      store.setState({
        revisionProposalsById: {
          ...current.revisionProposalsById,
          [proposalId]: result.value,
        },
        revisionProposalDetailStatusById: {
          ...current.revisionProposalDetailStatusById,
          [proposalId]: "ready",
        },
        revisionProposalDetailErrorById: {
          ...current.revisionProposalDetailErrorById,
          [proposalId]: null,
        },
      });
    })().finally(() => {
      revisionProposalRequests.delete(proposalId);
    });
    revisionProposalRequests.set(proposalId, request);
    return request;
  };

  const loadChapterHistory = (chapterId: string, force: boolean): Promise<void> => {
    const state = store.getState();
    if (!force && state.chapterHistoryStatusByChapter[chapterId] === "ready") {
      return Promise.resolve();
    }
    const active = chapterHistoryRequests.get(chapterId);
    if (active !== undefined) {
      if (!force) return active;
      const queuedActive = chapterHistoryQueuedRequests.get(chapterId);
      if (queuedActive !== undefined) return queuedActive;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const refresh = (): Promise<void> => {
        if (chapterHistoryQueuedRequests.get(chapterId) === queued) {
          chapterHistoryQueuedRequests.delete(chapterId);
        }
        return generation === authorizationGeneration
          ? loadChapterHistory(chapterId, true)
          : Promise.resolve();
      };
      queued = active.then(refresh, refresh);
      chapterHistoryQueuedRequests.set(chapterId, queued);
      return queued;
    }
    const read = api.chapterHistory;
    if (read === undefined) {
      store.setState({
        chapterHistoryStatusByChapter: {
          ...state.chapterHistoryStatusByChapter,
          [chapterId]: "error",
        },
        chapterHistoryErrorByChapter: {
          ...state.chapterHistoryErrorByChapter,
          [chapterId]: "chapter history is unavailable in this deployment",
        },
      });
      return Promise.resolve();
    }
    const generation = authorizationGeneration;
    const request = Promise.resolve()
      .then(async () => {
        const result = await read.call(api, chapterId);
        if (generation !== authorizationGeneration) return;
        const current = store.getState();
        if (!result.ok) {
          store.setState({
            chapterHistoryStatusByChapter: {
              ...current.chapterHistoryStatusByChapter,
              [chapterId]: "error",
            },
            chapterHistoryErrorByChapter: {
              ...current.chapterHistoryErrorByChapter,
              [chapterId]: result.message,
            },
          });
          return;
        }
        store.setState({
          chapterHistoryByChapter: {
            ...current.chapterHistoryByChapter,
            [chapterId]: {
              ...result.value,
              items: result.value.items.slice(0, MAX_CHAPTER_HISTORY_ROWS),
            },
          },
          chapterHistoryStatusByChapter: {
            ...current.chapterHistoryStatusByChapter,
            [chapterId]: "ready",
          },
          chapterHistoryErrorByChapter: {
            ...current.chapterHistoryErrorByChapter,
            [chapterId]: null,
          },
        });
      })
      .finally(() => {
        chapterHistoryRequests.delete(chapterId);
      });
    chapterHistoryRequests.set(chapterId, request);
    store.setState({
      chapterHistoryStatusByChapter: {
        ...state.chapterHistoryStatusByChapter,
        [chapterId]: "loading",
      },
      chapterHistoryErrorByChapter: {
        ...state.chapterHistoryErrorByChapter,
        [chapterId]: null,
      },
    });
    return request;
  };

  const loadChapterHistoryRevision = (
    chapterId: string,
    revision: number,
    compare: ChapterHistoryComparison,
    force: boolean,
  ): Promise<void> => {
    const key = chapterHistoryDetailKey(chapterId, revision, compare);
    const state = store.getState();
    if (!force && state.chapterHistoryDetailStatusByKey[key] === "ready") {
      return Promise.resolve();
    }
    const active = chapterHistoryDetailRequests.get(key);
    if (active !== undefined) {
      if (!force) return active;
      const queuedActive = chapterHistoryDetailQueuedRequests.get(key);
      if (queuedActive !== undefined) return queuedActive;
      const generation = authorizationGeneration;
      let queued!: Promise<void>;
      const refresh = (): Promise<void> => {
        if (chapterHistoryDetailQueuedRequests.get(key) === queued) {
          chapterHistoryDetailQueuedRequests.delete(key);
        }
        return generation === authorizationGeneration
          ? loadChapterHistoryRevision(chapterId, revision, compare, true)
          : Promise.resolve();
      };
      queued = active.then(refresh, refresh);
      chapterHistoryDetailQueuedRequests.set(key, queued);
      return queued;
    }
    const read = api.chapterHistoryRevision;
    if (read === undefined) {
      store.setState({
        chapterHistoryDetailStatusByKey: {
          ...state.chapterHistoryDetailStatusByKey,
          [key]: "error",
        },
        chapterHistoryDetailErrorByKey: {
          ...state.chapterHistoryDetailErrorByKey,
          [key]: "chapter history is unavailable in this deployment",
        },
      });
      return Promise.resolve();
    }
    const generation = authorizationGeneration;
    const request = Promise.resolve()
      .then(async () => {
        const result = await read.call(api, chapterId, revision, compare);
        if (generation !== authorizationGeneration) return;
        const current = store.getState();
        if (!result.ok) {
          store.setState({
            chapterHistoryDetailStatusByKey: {
              ...current.chapterHistoryDetailStatusByKey,
              [key]: "error",
            },
            chapterHistoryDetailErrorByKey: {
              ...current.chapterHistoryDetailErrorByKey,
              [key]: result.message,
            },
          });
          return;
        }
        const chapterHistoryDetailByKey = {
          ...current.chapterHistoryDetailByKey,
          [key]: result.value,
        };
        const chapterHistoryDetailStatusByKey = {
          ...current.chapterHistoryDetailStatusByKey,
          [key]: "ready" as const,
        };
        const chapterHistoryDetailErrorByKey = {
          ...current.chapterHistoryDetailErrorByKey,
          [key]: null,
        };
        const chapterKeys = Object.keys(chapterHistoryDetailByKey).filter(
          (candidate) => chapterHistoryDetailByKey[candidate]?.chapterId === chapterId,
        );
        const evictable = chapterKeys.filter((candidate) => candidate !== key);
        while (chapterKeys.length > MAX_CHAPTER_HISTORY_DETAILS) {
          const evicted = evictable.shift();
          if (evicted === undefined) break;
          chapterKeys.splice(chapterKeys.indexOf(evicted), 1);
          delete chapterHistoryDetailByKey[evicted];
          delete chapterHistoryDetailStatusByKey[evicted];
          delete chapterHistoryDetailErrorByKey[evicted];
        }
        store.setState({
          chapterHistoryDetailByKey,
          chapterHistoryDetailStatusByKey,
          chapterHistoryDetailErrorByKey,
        });
      })
      .finally(() => {
        chapterHistoryDetailRequests.delete(key);
      });
    chapterHistoryDetailRequests.set(key, request);
    store.setState({
      chapterHistoryDetailStatusByKey: {
        ...state.chapterHistoryDetailStatusByKey,
        [key]: "loading",
      },
      chapterHistoryDetailErrorByKey: {
        ...state.chapterHistoryDetailErrorByKey,
        [key]: null,
      },
    });
    return request;
  };

  const recoverAuthoritative = (): Promise<boolean> => {
    if (recoveryRequest !== null) {
      return recoveryRequest;
    }
    authoritativeReady = false;
    store.setState({
      connection: { ...store.getState().connection, status: "recovering" },
    });
    recoveryRequest = (async () => {
      const generation = authorizationGeneration;
      const state = store.getState();
      const jobs: Promise<unknown>[] = [];
      const requireSession = state.sessionStatus !== "idle";
      const requireChapters = state.chaptersStatus !== "idle";
      const requireWorkItems = state.workItemsStatus !== "idle";
      const requireCompletedWorkItems = state.completedWorkItemsStatus !== "idle";
      const requireRevisionProposals = state.revisionProposalsStatus !== "idle";
      const requiredHistoryChapters = Object.entries(state.chapterHistoryStatusByChapter)
        .filter(([, status]) => status !== "idle")
        .map(([chapterId]) => chapterId);
      const requiredHistoryDetails = Object.values(state.chapterHistoryDetailByKey);
      const requiredChapters = Object.entries(state.annotationStatusByChapter)
        .filter(([, status]) => status !== "idle")
        .map(([chapterId]) => chapterId);
      const requiredReplyParents = Object.entries(state.replyStatusByAnnotation)
        .filter(([, status]) => status !== "idle")
        .map(([annotationId]) => annotationId);
      if (requireSession) jobs.push(loadSession(true));
      if (requireChapters) jobs.push(loadChapters(true));
      if (requireWorkItems) jobs.push(loadWorkItems(true));
      if (requireCompletedWorkItems) jobs.push(loadCompletedWorkItems("refresh"));
      if (requireRevisionProposals) jobs.push(loadRevisionProposals(true));
      for (const chapterId of requiredHistoryChapters) {
        jobs.push(loadChapterHistory(chapterId, true));
      }
      for (const detail of requiredHistoryDetails) {
        jobs.push(
          loadChapterHistoryRevision(
            detail.chapterId,
            detail.selected.revision,
            detail.compare,
            true,
          ),
        );
      }
      for (const [chapterId, status] of Object.entries(state.annotationStatusByChapter)) {
        if (status !== "idle") jobs.push(loadAnnotations(chapterId, true));
      }
      for (const [annotationId, status] of Object.entries(state.replyStatusByAnnotation)) {
        if (status !== "idle") jobs.push(loadReplies(annotationId, true));
      }
      for (const [proposalId, status] of Object.entries(
        state.revisionProposalDetailStatusById,
      )) {
        if (status !== "idle") jobs.push(loadRevisionProposal(proposalId, true));
      }
      const settled = await Promise.allSettled(jobs);
      if (generation !== authorizationGeneration) return false;
      const fresh = store.getState();
      const failed: string[] = [];
      if (requireSession && fresh.sessionStatus !== "ready") failed.push("session");
      if (requireChapters && fresh.chaptersStatus !== "ready") failed.push("chapters");
      if (requireWorkItems && fresh.workItemsStatus !== "ready") failed.push("Work");
      if (
        requireCompletedWorkItems &&
        fresh.completedWorkItemsStatus !== "ready"
      ) {
        failed.push("completed Work");
      }
      if (requireRevisionProposals && fresh.revisionProposalsStatus !== "ready") {
        failed.push("revision proposals");
      }
      if (
        requiredHistoryChapters.some(
          (chapterId) => fresh.chapterHistoryStatusByChapter[chapterId] !== "ready",
        )
      ) {
        failed.push("chapter history");
      }
      for (const detail of requiredHistoryDetails) {
        const key = chapterHistoryDetailKey(
          detail.chapterId,
          detail.selected.revision,
          detail.compare,
        );
        if (fresh.chapterHistoryDetailStatusByKey[key] !== "ready") {
          failed.push(`chapter history revision ${detail.selected.revision}`);
        }
      }
      for (const proposalId of Object.keys(state.revisionProposalDetailStatusById)) {
        if (fresh.revisionProposalDetailStatusById[proposalId] !== "ready") {
          failed.push(`revision ${proposalId}`);
        }
      }
      if (
        requiredChapters.some(
          (chapterId) => fresh.annotationStatusByChapter[chapterId] !== "ready",
        )
      ) {
        failed.push("annotations");
      }
      if (
        requiredReplyParents.some(
          (annotationId) => fresh.replyStatusByAnnotation[annotationId] !== "ready",
        )
      ) {
        failed.push("replies");
      }
      if (settled.some((result) => result.status === "rejected")) {
        failed.push("network reads");
      }
      if (connectionUsers === 0) {
        store.setState({
          connection: {
            ...store.getState().connection,
            status: "idle",
          },
        });
        return false;
      }
      if (failed.length > 0) {
        const unique = [...new Set(failed)];
        store.setState({
          connection: {
            ...store.getState().connection,
            status: "offline",
            lastError: `authoritative refresh failed: ${unique.join(", ")}`,
          },
        });
        if (events !== null) {
          scheduleConnectionRetry(() => void recoverAuthoritative());
        }
        return false;
      }
      for (const mutation of Object.values(store.getState().pendingMutations)) {
        if (mutation.phase === "optimistic") continue;
        // A generic read cannot prove whether any response-lost write is still
        // committing. Preserve every ambiguous key for an exact same-key
        // replay; only accepted mutations may settle from recovered state.
        if (mutation.phase === "ambiguous") {
          continue;
        }
        const relevantReadReady =
          (mutation.chapterId !== null &&
            (store.getState().chaptersStatus === "ready" ||
              store.getState().annotationStatusByChapter[mutation.chapterId] === "ready")) ||
          (mutation.annotationId !== null &&
            store.getState().replyStatusByAnnotation[mutation.annotationId] === "ready") ||
          (mutation.workItemId !== null && store.getState().workItemsStatus === "ready");
        if (mutation.phase === "accepted" && relevantReadReady) {
          removePendingMutation(mutation.id);
          settleCommand(mutation.fingerprint);
        }
      }
      authoritativeReady = true;
      connectionFailures = 0;
      clearConnectionRetry();
      store.setState({
        connection: {
          ...store.getState().connection,
          status: events !== null && transportConnected ? "live" : "connecting",
          lastError: null,
        },
      });
      return true;
    })().finally(() => {
      recoveryRequest = null;
    });
    return recoveryRequest;
  };

  const refreshForEvent = (event: FeedEvent): void => {
    const chapterId =
      typeof event.payload["chapterId"] === "string"
        ? event.payload["chapterId"]
        : null;
    const annotationId =
      typeof event.payload["annotationId"] === "string"
        ? event.payload["annotationId"]
        : null;
    const operationId =
      typeof event.payload["operationId"] === "string"
        ? event.payload["operationId"]
        : null;
    const workItemId =
      typeof event.payload["workItemId"] === "string"
        ? event.payload["workItemId"]
        : null;
    const correlationId =
      typeof event.payload["correlationId"] === "string"
        ? event.payload["correlationId"]
        : null;
    const submissionId =
      typeof event.payload["submissionId"] === "string"
        ? event.payload["submissionId"]
        : null;
    const revisionProposalId =
      typeof event.payload["revisionProposalId"] === "string"
        ? event.payload["revisionProposalId"]
        : typeof event.payload["proposalId"] === "string"
          ? event.payload["proposalId"]
          : null;
    if (workItemId !== null && event.type === "lease_renewed") {
      const claim = store.getState().activeClaimsByWorkItem[workItemId];
      const expiresAt = event.payload["expiresAt"];
      if (claim !== undefined && typeof expiresAt === "string") {
        const renewalPromptAt = event.payload["renewalPromptAt"];
        const maxExpiresAt = event.payload["maxExpiresAt"];
        const { renewalPromptAt: _stalePrompt, ...baseLease } = claim.lease;
        store.setState({
          activeClaimsByWorkItem: {
            ...store.getState().activeClaimsByWorkItem,
            [workItemId]: {
              ...claim,
              lease: {
                ...baseLease,
                expiresAt,
                ...(typeof maxExpiresAt === "string" ? { maxExpiresAt } : {}),
                ...(typeof renewalPromptAt === "string" ? { renewalPromptAt } : {}),
              },
            },
          },
        });
      }
    }
    if (workItemId !== null && event.type === "lease_recovered") {
      const ownRecoveries = leaseRecoveryCorrelations.get(workItemId);
      if (correlationId !== null && ownRecoveries?.has(correlationId) === true) {
        ownRecoveries.delete(correlationId);
        if (ownRecoveries.size === 0) leaseRecoveryCorrelations.delete(workItemId);
      } else {
        invalidateClaim(workItemId, "The lease token was replaced in another session.");
      }
    }
    if (workItemId !== null && event.type === "submission_received") {
      const local = localSubmissionCommands.get(workItemId);
      if (local !== undefined && correlationId === local.correlationId) {
        const accepted =
          submissionId !== null && operationId !== null
            ? {
                submissionId,
                operationId,
                correlationId,
                status: "queued",
              }
            : null;
        localSubmissionCommands.set(workItemId, {
          ...local,
          ...(submissionId === null ? {} : { submissionId }),
          ...(operationId === null ? {} : { operationId }),
        });
        if (accepted !== null) {
          // `submission_received` is committed in the same batch that consumes
          // the lease. Treat it as an authoritative accepted response for this
          // tab, even when the HTTP response never arrives.
          consumeLocalClaim(workItemId);
          settleCommand(local.fingerprint);
          store.setState({
            submissionAcceptancesByWorkItem: {
              ...store.getState().submissionAcceptancesByWorkItem,
              [workItemId]: accepted,
            },
          });
        }
      } else {
        invalidateClaim(workItemId, "The lease ended in another session.");
      }
    }
    if (
      workItemId !== null &&
      (event.type === "work_item_completed" || event.type === "work_item_conflict")
    ) {
      const local = localSubmissionCommands.get(workItemId);
      if (
        local !== undefined &&
        submissionId !== null &&
        local.submissionId === submissionId
      ) {
        if (local.operationId === undefined) {
          localSubmissionCommands.set(workItemId, {
            ...local,
            terminalEventSeen: true,
          });
        } else {
          localSubmissionCommands.delete(workItemId);
        }
      } else {
        invalidateClaim(workItemId, "The lease ended in another session.");
      }
    }
    if (
      workItemId !== null &&
      (event.type === "lease_released" ||
        event.type === "lease_expired" ||
        event.type === "lease_revoked")
    ) {
      invalidateClaim(workItemId, "The lease ended in another session.");
    }
    if (event.type === "operation_completed" && operationId !== null) {
      for (const [localWorkItemId, local] of localSubmissionCommands) {
        if (local.operationId === operationId) {
          localSubmissionCommands.delete(localWorkItemId);
          break;
        }
      }
      void store.getState().refreshOperation(operationId);
    }
    if (event.type === "vote_aggregate" && annotationId !== null) {
      const votes = event.payload["votes"];
      const annotation = store.getState().annotationsById[annotationId];
      if (annotation !== undefined && typeof votes === "object" && votes !== null) {
        store.setState({
          annotationsById: {
            ...store.getState().annotationsById,
            [annotationId]: {
              ...annotation,
              votes: votes as NonNullable<Annotation["votes"]>,
            },
          },
        });
      }
    }
    if (chapterId !== null && store.getState().annotationStatusByChapter[chapterId] !== undefined) {
      void loadAnnotations(chapterId, true);
    } else {
      for (const loadedChapter of Object.keys(store.getState().annotationStatusByChapter)) {
        void loadAnnotations(loadedChapter, true);
      }
    }
    if (annotationId !== null && store.getState().replyStatusByAnnotation[annotationId] !== undefined) {
      void loadReplies(annotationId, true);
    }
    if (store.getState().workItemsStatus !== "idle") void loadWorkItems(true);
    if (store.getState().completedWorkItemsStatus !== "idle") {
      void loadCompletedWorkItems("refresh");
    }
    if (store.getState().chaptersStatus !== "idle") void loadChapters(true);
    if (
      chapterId !== null &&
      store.getState().chapterHistoryStatusByChapter[chapterId] !== undefined
    ) {
      void loadChapterHistory(chapterId, true);
    }
    if (
      (revisionProposalId !== null || event.type.startsWith("revision_proposal_")) &&
      store.getState().revisionProposalsStatus !== "idle"
    ) {
      void loadRevisionProposals(true);
    }
    if (
      revisionProposalId !== null &&
      store.getState().revisionProposalDetailStatusById[revisionProposalId] !== undefined
    ) {
      void loadRevisionProposal(revisionProposalId, true);
    }
  };

  const startEvents = (): Promise<void> => {
    if (
      events !== null ||
      startingEvents !== null ||
      connectionRetryTimer !== undefined ||
      api.pollEvents === undefined ||
      api.eventsUrl === undefined
    ) {
      return startingEvents ?? Promise.resolve();
    }
    store.setState({
      connection: { ...store.getState().connection, status: "connecting", lastError: null },
    });
    const generation = authorizationGeneration;
    startingEvents = (async () => {
      let primed: Awaited<ReturnType<NonNullable<ProjectStoreApi["pollEvents"]>>>;
      try {
        primed = await api.pollEvents!(0);
      } catch {
        if (generation !== authorizationGeneration) return;
        if (connectionUsers > 0) {
          authoritativeReady = false;
          store.setState({
            connection: {
              ...store.getState().connection,
              status: "offline",
              lastError: "event feed bootstrap failed; retrying",
            },
          });
          scheduleConnectionRetry(() => void startEvents());
        }
        return;
      }
      if (generation !== authorizationGeneration) return;
      if (!primed.ok || connectionUsers === 0) {
        const permanent = !primed.ok && (primed.status === 404 || primed.status === 405);
        authoritativeReady = false;
        store.setState({
          connection: {
            ...store.getState().connection,
            status: connectionUsers === 0 || permanent ? "idle" : "offline",
            lastError: !primed.ok ? primed.message : null,
          },
        });
        if (connectionUsers > 0 && !permanent) {
          scheduleConnectionRetry(() => void startEvents());
        }
        return;
      }
      const recovered = await recoverAuthoritative();
      if (generation !== authorizationGeneration) return;
      if (!recovered) {
        if (connectionUsers > 0) {
          scheduleConnectionRetry(() => void startEvents());
        }
        return;
      }
      if (connectionUsers === 0) return;
      events = new CollabEvents({
        url: api.eventsUrl?.() ?? "",
        initialCursor: primed.value.latestId,
        onEvent: (event) => {
          if (generation !== authorizationGeneration) return;
          store.setState({
            connection: {
              ...store.getState().connection,
              cursor: Math.max(store.getState().connection.cursor, event.id),
            },
          });
          refreshForEvent(event);
        },
        onReconnect: () => {
          if (generation === authorizationGeneration) void recoverAuthoritative();
        },
        onStatus: (status) => {
          if (generation !== authorizationGeneration) return;
          const transport = status.transport ?? "none";
          transportConnected = status.state === "connected";
          if (status.state === "retrying") {
            authoritativeReady = false;
          }
          const state =
            status.state === "connected"
              ? authoritativeReady
                ? "live"
                : "recovering"
              : status.state === "retrying"
                ? "offline"
                : status.state === "connecting"
                  ? "connecting"
                  : "idle";
          const nextConnection: ConnectionState = {
            transport,
            status: state,
            cursor: status.cursor,
            lastError:
              status.state === "retrying"
                ? "event feed interrupted; retrying"
                : status.state === "unsupported"
                  ? "event feed unavailable"
                  : null,
          };
          const currentConnection = store.getState().connection;
          if (
            currentConnection.transport !== nextConnection.transport ||
            currentConnection.status !== nextConnection.status ||
            currentConnection.cursor !== nextConnection.cursor ||
            currentConnection.lastError !== nextConnection.lastError
          ) {
            store.setState({ connection: nextConnection });
          }
        },
        poll: async (after) => {
          if (generation !== authorizationGeneration) return { ok: false };
          const result = await api.pollEvents?.(after);
          if (generation !== authorizationGeneration) return { ok: false };
          if (result === undefined) return { ok: false };
          return result.ok
            ? { ok: true, items: result.value.items, latestId: result.value.latestId }
            : { ok: false, status: result.status, message: result.message };
        },
      });
      store.setState({
        connection: {
          transport: typeof globalThis.EventSource === "function" ? "sse" : "poll",
          status: "connecting",
          cursor: primed.value.latestId,
          lastError: null,
        },
      });
      events.start();
    })().finally(() => {
      startingEvents = null;
    });
    return startingEvents;
  };

  const shouldReplay = <T>(result: ApiResult<T>): boolean =>
    !result.ok &&
    (result.ambiguous === true || result.status === 0 || result.status >= 500);

  const replayOnce = async <T>(call: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    const first = await call();
    return shouldReplay(first) ? call() : first;
  };

  const consumeLocalClaim = (workItemId: string): void => {
    leaseSecrets.delete(workItemId);
    leaseRecoveryCorrelations.delete(workItemId);
    const activeClaimsByWorkItem = { ...store.getState().activeClaimsByWorkItem };
    delete activeClaimsByWorkItem[workItemId];
    store.setState({ activeClaimsByWorkItem });
  };

  const clearLocalClaim = (workItemId: string): void => {
    consumeLocalClaim(workItemId);
    localSubmissionCommands.delete(workItemId);
  };

  const invalidateClaim = (workItemId: string, message: string): void => {
    // Terminal events are routinely replayed after the submitting tab has
    // already consumed and removed its claim. Only an editor that still owns
    // an active local capability can be invalidated by an external event.
    if (store.getState().activeClaimsByWorkItem[workItemId] === undefined) {
      return;
    }
    clearLocalClaim(workItemId);
    store.setState({
      claimInvalidationsByWorkItem: {
        ...store.getState().claimInvalidationsByWorkItem,
        [workItemId]: message,
      },
    });
  };

  const failOptimistic = async <T>(options: {
    result: Extract<ApiResult<T>, { ok: false }>;
    mutationId: string;
    fingerprint: string;
    chapterId: string | null;
    annotationId: string | null;
    refreshWork?: boolean;
    /**
     * A claim whose response was lost must keep its original key and local
     * queue row: the authoritative ready-only queue cannot return the lease
     * id needed for token recovery.
     */
    retainAmbiguous?: boolean;
    rollback(): void;
  }): Promise<StoreActionResult<never>> => {
    const failure = actionFailure(options.result);
    if (!failure.ok && failure.kind === "ambiguous") {
      options.rollback();
      if (options.retainAmbiguous === true) {
        updatePendingMutation(options.mutationId, "ambiguous");
        if (options.refreshWork === true) await loadWorkItems(true);
        return failure;
      }
      await reconcileAmbiguous(
        options.mutationId,
        options.chapterId,
        options.annotationId,
        options.refreshWork === true,
      );
      return failure;
    }
    options.rollback();
    removePendingMutation(options.mutationId, true);
    settleCommand(options.fingerprint);
    // A feed event can win the race with this rejected response. Re-reading
    // every loaded affected resource prevents rollback from restoring a
    // pre-event snapshot and silently leaving the page stale.
    await refreshMutationResources(
      options.chapterId,
      options.annotationId,
      options.refreshWork === true,
    );
    return failure;
  };

  const createAnnotation = async (
    chapterId: string,
    command: AnnotationCommand,
  ): Promise<StoreActionResult<CreateAnnotationAccepted>> => {
    const write = api.createAnnotation;
    if (write === undefined) return unsupported("annotation creation");
    const generation = authorizationGeneration;
    const id = mutationId();
    const localId = `local:${id}`;
    const fingerprint = commandFingerprint("annotation.create", chapterId, command);
    const key = retainedKeyFor(fingerprint);
    const now = new Date().toISOString();
    const optimistic: Annotation = {
      id: localId,
      chapterId,
      kind: command.kind,
      scope: command.scope,
      chapterRevision: command.chapterRevision,
      target: command.target ?? null,
      authorActorId: store.getState().session?.actor.id ?? "",
      body: command.body,
      status: "pending_git",
      gitOperationId: null,
      createdAt: now,
    };
    const previousIds = store.getState().annotationIdsByChapter[chapterId] ?? [];
    store.setState({
      annotationsById: { ...store.getState().annotationsById, [localId]: optimistic },
      annotationIdsByChapter: {
        ...store.getState().annotationIdsByChapter,
        [chapterId]: [...previousIds, localId],
      },
    });
    addPendingMutation({
      id,
      kind: "annotation.create",
      phase: "optimistic",
      idempotencyKey: key,
      fingerprint,
      chapterId,
      annotationId: localId,
      workItemId: null,
      activityDelta: annotationActivity(optimistic, 1),
    });
    const options: MutationOptions = { idempotencyKey: key };
    const result = await replayOnce(() => write.call(api, chapterId, command, options));
    if (generation !== authorizationGeneration) return credentialChanged();
    const removeLocal = (): void => {
      const annotationsById = { ...store.getState().annotationsById };
      delete annotationsById[localId];
      store.setState({
        annotationsById,
        annotationIdsByChapter: {
          ...store.getState().annotationIdsByChapter,
          [chapterId]: (store.getState().annotationIdsByChapter[chapterId] ?? []).filter(
            (candidate) => candidate !== localId,
          ),
        },
      });
    };
    if (!result.ok) {
      return failOptimistic({
        result,
        mutationId: id,
        fingerprint,
        chapterId,
        annotationId: localId,
        rollback: removeLocal,
      });
    }
    if (result.value.outcome === "pending_review") {
      removeLocal();
      removePendingMutation(id, true);
      settleCommand(fingerprint);
      return { ok: true, value: result.value };
    }
    const accepted = result.value;
    const annotationsById = { ...store.getState().annotationsById };
    const alreadyAuthoritative = annotationsById[accepted.annotationId];
    delete annotationsById[localId];
    annotationsById[accepted.annotationId] =
      alreadyAuthoritative ??
      {
        ...optimistic,
        id: accepted.annotationId,
        status: "pending_git",
        gitOperationId: accepted.operationId,
      };
    store.setState({
      annotationsById,
      annotationIdsByChapter: {
        ...store.getState().annotationIdsByChapter,
        [chapterId]: (store.getState().annotationIdsByChapter[chapterId] ?? []).map(
          (candidate) => (candidate === localId ? accepted.annotationId : candidate),
        ),
      },
    });
    const pendingMutation = store.getState().pendingMutations[id];
    if (pendingMutation !== undefined) {
      setPendingMutations({
        ...store.getState().pendingMutations,
        [id]: { ...pendingMutation, annotationId: accepted.annotationId },
      });
    }
    await registerOperationContext(accepted.operationId, {
      kind: "annotation.create",
      chapterId,
      workItemId: null,
      annotationId: accepted.annotationId,
      mutationId: id,
      fingerprint,
    });
    await settleAcceptedMutation(id, fingerprint, chapterId, accepted.annotationId, false, true);
    return { ok: true, value: accepted };
  };

  const createReply = async (
    annotationId: string,
    body: string,
    parentReplyId?: string,
  ): Promise<StoreActionResult<ReplyAccepted>> => {
    const write = api.createReply;
    if (write === undefined) return unsupported("reply creation");
    const generation = authorizationGeneration;
    const annotation = store.getState().annotationsById[annotationId];
    const chapterId = annotation?.chapterId ?? null;
    const id = mutationId();
    const localId = `local:${id}`;
    const fingerprint = commandFingerprint(
      "reply.create",
      annotationId,
      parentReplyId ?? null,
      body,
    );
    const key = retainedKeyFor(fingerprint);
    const now = new Date().toISOString();
    const optimistic: Reply = {
      id: localId,
      projectId: config.project,
      annotationId,
      parentReplyId: parentReplyId ?? null,
      authorActorId: store.getState().session?.actor.id ?? "",
      body,
      status: "pending_git",
      gitOperationId: null,
      createdAt: now,
      updatedAt: now,
    };
    const previousIds = store.getState().replyIdsByAnnotation[annotationId] ?? [];
    store.setState({
      repliesById: { ...store.getState().repliesById, [localId]: optimistic },
      replyIdsByAnnotation: {
        ...store.getState().replyIdsByAnnotation,
        [annotationId]: [...previousIds, localId],
      },
    });
    addPendingMutation({
      id,
      kind: "reply.create",
      phase: "optimistic",
      idempotencyKey: key,
      fingerprint,
      chapterId,
      annotationId,
      workItemId: null,
      activityDelta: { openReplies: 1 },
    });
    const options: MutationOptions = { idempotencyKey: key };
    const result = await replayOnce(() =>
      write.call(api, annotationId, body, parentReplyId, options),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    const removeLocal = (): void => {
      const repliesById = { ...store.getState().repliesById };
      delete repliesById[localId];
      store.setState({
        repliesById,
        replyIdsByAnnotation: {
          ...store.getState().replyIdsByAnnotation,
          [annotationId]: (store.getState().replyIdsByAnnotation[annotationId] ?? []).filter(
            (candidate) => candidate !== localId,
          ),
        },
      });
    };
    if (!result.ok) {
      return failOptimistic({
        result,
        mutationId: id,
        fingerprint,
        chapterId,
        annotationId,
        rollback: removeLocal,
      });
    }
    const repliesById = { ...store.getState().repliesById };
    const alreadyAuthoritative = repliesById[result.value.replyId];
    delete repliesById[localId];
    repliesById[result.value.replyId] =
      alreadyAuthoritative ??
      {
        ...optimistic,
        id: result.value.replyId,
        gitOperationId: result.value.operationId,
      };
    store.setState({
      repliesById,
      replyIdsByAnnotation: {
        ...store.getState().replyIdsByAnnotation,
        [annotationId]: (store.getState().replyIdsByAnnotation[annotationId] ?? []).map(
          (candidate) => (candidate === localId ? result.value.replyId : candidate),
        ),
      },
    });
    await registerOperationContext(result.value.operationId, {
      kind: "reply.create",
      chapterId,
      workItemId: null,
      replyAnnotationId: annotationId,
      mutationId: id,
      fingerprint,
    });
    await settleAcceptedMutation(id, fingerprint, chapterId, annotationId, false, true);
    return { ok: true, value: result.value };
  };

  const withdrawAnnotation = async (
    annotationId: string,
  ): Promise<StoreActionResult<WithdrawAccepted>> => {
    const write = api.withdraw;
    const before = store.getState().annotationsById[annotationId];
    if (write === undefined) return unsupported("annotation withdrawal");
    if (before === undefined) return unsupported("annotation");
    const generation = authorizationGeneration;
    const id = mutationId();
    const fingerprint = commandFingerprint("annotation.withdraw", annotationId);
    const key = retainedKeyFor(fingerprint);
    const openReplies = visibleReplyCount(annotationId);
    const activityDelta = {
      ...annotationActivity(before, -1),
      ...(openReplies === 0 ? {} : { openReplies: -openReplies }),
    };
    store.setState({
      annotationsById: {
        ...store.getState().annotationsById,
        [annotationId]: { ...before, status: "withdrawn" },
      },
    });
    addPendingMutation({
      id,
      kind: "annotation.withdraw",
      phase: "optimistic",
      idempotencyKey: key,
      fingerprint,
      chapterId: before.chapterId,
      annotationId,
      workItemId: null,
      activityDelta,
    });
    const result = await replayOnce(() =>
      write.call(api, annotationId, { idempotencyKey: key }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      return failOptimistic({
        result,
        mutationId: id,
        fingerprint,
        chapterId: before.chapterId,
        annotationId,
        rollback: () => {
          store.setState({
            annotationsById: {
              ...store.getState().annotationsById,
              [annotationId]: before,
            },
          });
        },
      });
    }
    await registerOperationContext(result.value.operationId, {
      kind: "annotation.withdraw",
      chapterId: before.chapterId,
      workItemId: null,
      annotationId,
      mutationId: id,
      fingerprint,
    });
    await settleAcceptedMutation(id, fingerprint, before.chapterId, annotationId, false, true);
    return { ok: true, value: result.value };
  };

  const withdrawReply = async (
    annotationId: string,
    replyId: string,
  ): Promise<StoreActionResult<ReplyWithdrawAccepted>> => {
    const write = api.withdrawReply;
    const before = store.getState().repliesById[replyId];
    if (write === undefined) return unsupported("reply withdrawal");
    if (before === undefined || before.annotationId !== annotationId) {
      return unsupported("reply");
    }
    const generation = authorizationGeneration;
    const annotation = store.getState().annotationsById[annotationId];
    const chapterId = annotation?.chapterId ?? null;
    const id = mutationId();
    const fingerprint = commandFingerprint("reply.withdraw", annotationId, replyId);
    const key = retainedKeyFor(fingerprint);
    store.setState({
      repliesById: {
        ...store.getState().repliesById,
        [replyId]: { ...before, status: "withdrawn" },
      },
    });
    addPendingMutation({
      id,
      kind: "reply.withdraw",
      phase: "optimistic",
      idempotencyKey: key,
      fingerprint,
      chapterId,
      annotationId,
      workItemId: null,
      activityDelta: { openReplies: -1 },
    });
    const result = await replayOnce(() =>
      write.call(api, annotationId, replyId, { idempotencyKey: key }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      return failOptimistic({
        result,
        mutationId: id,
        fingerprint,
        chapterId,
        annotationId,
        rollback: () => {
          store.setState({
            repliesById: {
              ...store.getState().repliesById,
              [replyId]: before,
            },
          });
        },
      });
    }
    const current = store.getState().repliesById[replyId] ?? before;
    store.setState({
      repliesById: {
        ...store.getState().repliesById,
        [replyId]: {
          ...current,
          status: "withdrawn",
          gitOperationId: result.value.operationId,
        },
      },
    });
    updatePendingMutation(id, "accepted");
    await registerOperationContext(result.value.operationId, {
      kind: "reply.withdraw",
      chapterId,
      workItemId: null,
      replyAnnotationId: annotationId,
      mutationId: id,
      fingerprint,
    });
    return { ok: true, value: result.value };
  };

  const setVote = async (
    annotationId: string,
    value: VoteValue | null,
  ): Promise<StoreActionResult<VoteResult>> => {
    const before = store.getState().annotationsById[annotationId];
    const write = value === null ? api.clearVote : api.castVote;
    if (write === undefined) return unsupported("voting");
    if (before === undefined) return unsupported("annotation");
    const generation = authorizationGeneration;
    const id = mutationId();
    const fingerprint = commandFingerprint("vote.set", annotationId, value);
    const key = retainedKeyFor(fingerprint);
    const votes = {
      approvals: before.votes?.approvals ?? 0,
      rejections: before.votes?.rejections ?? 0,
      abstentions: before.votes?.abstentions ?? 0,
      netScore: before.votes?.netScore ?? 0,
      distinctVoters: before.votes?.distinctVoters ?? 0,
      humanApprovals: before.votes?.humanApprovals ?? 0,
      agentApprovals: before.votes?.agentApprovals ?? 0,
      ...(before.votes?.maintainerApprovals === undefined
        ? {}
        : { maintainerApprovals: before.votes.maintainerApprovals }),
      ...(before.votes?.humanMaintainerApprovals === undefined
        ? {}
        : { humanMaintainerApprovals: before.votes.humanMaintainerApprovals }),
    };
    const adjust = (vote: VoteValue | null | undefined, amount: 1 | -1): void => {
      if (vote === "approve") votes.approvals = Math.max(0, votes.approvals + amount);
      if (vote === "reject") votes.rejections = Math.max(0, votes.rejections + amount);
      if (vote === "abstain") votes.abstentions = Math.max(0, votes.abstentions + amount);
    };
    adjust(before.myVote, -1);
    adjust(value, 1);
    votes.netScore = votes.approvals - votes.rejections;
    if (before.myVote == null && value !== null) votes.distinctVoters += 1;
    if (before.myVote != null && value === null) {
      votes.distinctVoters = Math.max(0, votes.distinctVoters - 1);
    }
    store.setState({
      annotationsById: {
        ...store.getState().annotationsById,
        [annotationId]: { ...before, myVote: value, votes },
      },
    });
    addPendingMutation({
      id,
      kind: "vote.set",
      phase: "optimistic",
      idempotencyKey: key,
      fingerprint,
      chapterId: before.chapterId,
      annotationId,
      workItemId: null,
      activityDelta: {},
    });
    const result = await replayOnce(() =>
      value === null
        ? (api.clearVote as NonNullable<ProjectStoreApi["clearVote"]>).call(
            api,
            annotationId,
            { idempotencyKey: key },
          )
        : (api.castVote as NonNullable<ProjectStoreApi["castVote"]>).call(
            api,
            annotationId,
            value,
            { idempotencyKey: key },
          ),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      return failOptimistic({
        result,
        mutationId: id,
        fingerprint,
        chapterId: before.chapterId,
        annotationId,
        rollback: () => {
          store.setState({
            annotationsById: {
              ...store.getState().annotationsById,
              [annotationId]: before,
            },
          });
        },
      });
    }
    const crossed = before.decision == null && result.value.decision != null;
    if (crossed) {
      const replyCount = visibleReplyCount(annotationId);
      updatePendingActivity(id, {
        ...annotationActivity(before, -1),
        ...(replyCount === 0 ? {} : { openReplies: -replyCount }),
        openWorkItems: 1,
      });
    }
    store.setState({
      annotationsById: {
        ...store.getState().annotationsById,
        [annotationId]: {
          ...before,
          status: crossed ? "work_item_created" : before.status,
          myVote: result.value.value,
          votes: result.value.votes,
          decision: result.value.decision,
        },
      },
    });
    await settleAcceptedMutation(id, fingerprint, before.chapterId, annotationId, crossed);
    return { ok: true, value: result.value };
  };

  const overrideAnnotation = async (
    annotationId: string,
    action: "promote" | "reject",
    reason = "",
  ): Promise<StoreActionResult<OverrideResult>> => {
    const before = store.getState().annotationsById[annotationId];
    const write = action === "promote" ? api.promoteToWork : api.rejectSuggestion;
    if (write === undefined) return unsupported(`${action} annotation`);
    if (before === undefined) return unsupported("annotation");
    const generation = authorizationGeneration;
    const id = mutationId();
    const fingerprint = commandFingerprint("annotation.override", annotationId, action, reason);
    const key = retainedKeyFor(fingerprint);
    const replyCount = visibleReplyCount(annotationId);
    const delta = {
      ...annotationActivity(before, -1),
      ...(replyCount === 0 ? {} : { openReplies: -replyCount }),
      ...(action === "promote" ? { openWorkItems: 1 } : {}),
    };
    store.setState({
      annotationsById: {
        ...store.getState().annotationsById,
        [annotationId]: {
          ...before,
          status: action === "promote" ? "work_item_created" : "rejected",
        },
      },
    });
    addPendingMutation({
      id,
      kind: action === "promote" ? "work.promote" : "annotation.reject",
      phase: "optimistic",
      idempotencyKey: key,
      fingerprint,
      chapterId: before.chapterId,
      annotationId,
      workItemId: null,
      activityDelta: delta,
    });
    const result = await replayOnce(() =>
      action === "promote"
        ? (api.promoteToWork as NonNullable<ProjectStoreApi["promoteToWork"]>).call(
            api,
            annotationId,
            undefined,
            { idempotencyKey: key },
          )
        : (api.rejectSuggestion as NonNullable<ProjectStoreApi["rejectSuggestion"]>).call(
            api,
            annotationId,
            reason,
            { idempotencyKey: key },
          ),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      return failOptimistic({
        result,
        mutationId: id,
        fingerprint,
        chapterId: before.chapterId,
        annotationId,
        refreshWork: action === "promote",
        rollback: () => {
          store.setState({
            annotationsById: {
              ...store.getState().annotationsById,
              [annotationId]: before,
            },
          });
        },
      });
    }
    const next: Annotation = {
      ...before,
      status: result.value.status,
      ...(action === "promote"
        ? {
            decision: {
              id: result.value.decisionId,
              actionType: "create_work_item",
              result: "create_work_item",
              supportChanged: false,
              workItemId: result.value.workItemId ?? null,
            },
          }
        : {}),
    };
    store.setState({
      annotationsById: {
        ...store.getState().annotationsById,
        [annotationId]: next,
      },
    });
    await settleAcceptedMutation(
      id,
      fingerprint,
      before.chapterId,
      annotationId,
      action === "promote",
    );
    return { ok: true, value: result.value };
  };

  const recoverClaim = async (
    bundle: SafeTaskBundle,
  ): Promise<StoreActionResult<SafeTaskBundle>> => {
    const write = api.recoverLease;
    if (write === undefined) return unsupported("lease recovery");
    const generation = authorizationGeneration;
    let lastFailure: StoreActionResult<never> | null = null;
    // A lost recovery response can be followed by a new logical rotation: the
    // second token atomically invalidates the first one that never reached us.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptCorrelation = mutationId();
      const ownRecoveries = leaseRecoveryCorrelations.get(bundle.workItem.id) ?? new Set<string>();
      ownRecoveries.add(attemptCorrelation);
      leaseRecoveryCorrelations.set(bundle.workItem.id, ownRecoveries);
      const result: ApiResult<LeaseRecovery> = await write.call(
        api,
        bundle.workItem.id,
        bundle.lease.id,
        {
          idempotencyKey: attemptCorrelation,
          correlationId: attemptCorrelation,
        },
      );
      if (generation !== authorizationGeneration) return credentialChanged();
      if (!result.ok) {
        lastFailure = actionFailure(result);
        if (!shouldReplay(result)) {
          ownRecoveries.delete(attemptCorrelation);
          if (ownRecoveries.size === 0) leaseRecoveryCorrelations.delete(bundle.workItem.id);
          return lastFailure;
        }
        continue;
      }
      if (
        typeof result.value.lease !== "object" ||
        result.value.lease === null ||
        typeof result.value.lease.token !== "string" ||
        result.value.lease.token === ""
      ) {
        lastFailure = {
          ok: false,
          kind: "ambiguous",
          status: 200,
          message: "the recovered lease token was redacted before it reached this page",
        };
        continue;
      }
      leaseSecrets.set(bundle.workItem.id, {
        leaseId: result.value.lease.id,
        token: result.value.lease.token,
      });
      ownRecoveries.add(result.value.correlationId);
      const safe: SafeTaskBundle = {
        ...bundle,
        lease: {
          id: result.value.lease.id,
          expiresAt: result.value.lease.expiresAt,
          maxExpiresAt: result.value.lease.maxExpiresAt,
          renewalPromptAt: result.value.lease.renewalPromptAt,
        },
      };
      const claimInvalidationsByWorkItem = {
        ...store.getState().claimInvalidationsByWorkItem,
      };
      delete claimInvalidationsByWorkItem[bundle.workItem.id];
      store.setState({
        activeClaimsByWorkItem: {
          ...store.getState().activeClaimsByWorkItem,
          [bundle.workItem.id]: safe,
        },
        claimInvalidationsByWorkItem,
      });
      return { ok: true, value: safe };
    }
    return lastFailure ?? {
      ok: false,
      kind: "ambiguous",
      status: 0,
      message: "lease recovery did not return a usable token",
    };
  };

  const claimWork = async (
    workItemId: string,
  ): Promise<StoreActionResult<SafeTaskBundle>> => {
    const write = api.claim;
    if (write === undefined) return unsupported("work claiming");
    const generation = authorizationGeneration;
    const item = store.getState().workItemsById[workItemId];
    const id = mutationId();
    const fingerprint = commandFingerprint("work.claim", workItemId);
    const key = retainedKeyFor(fingerprint);
    store.setState({
      workItemIds: store.getState().workItemIds.filter((candidate) => candidate !== workItemId),
    });
    addPendingMutation({
      id,
      kind: "work.claim",
      phase: "optimistic",
      idempotencyKey: key,
      fingerprint,
      chapterId: item?.chapterId ?? null,
      annotationId: item?.sourceAnnotationId ?? null,
      workItemId,
      activityDelta: {},
    });
    const result = await replayOnce(() =>
      write.call(api, workItemId, { idempotencyKey: key }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    const claimedToken = result.ok ? result.value.lease?.token : undefined;
    const invalidBundle = typeof claimedToken !== "string" || claimedToken === "";
    if (result.ok && invalidBundle) {
      const lease = result.value.lease as TaskBundle["lease"] & {
        tokenRedacted?: true;
      };
      if (typeof lease.id === "string") {
        const {
          token: _redactedToken,
          tokenRedacted: _redactedMarker,
          ...safeLease
        } = lease;
        const recovered = await recoverClaim({ ...result.value, lease: safeLease });
        if (generation !== authorizationGeneration) return credentialChanged();
        if (recovered.ok) {
          removePendingMutation(id);
          settleCommand(fingerprint);
          return recovered;
        }
      }
    }
    if (!result.ok || invalidBundle) {
      const failed: Extract<ApiResult<TaskBundle>, { ok: false }> = result.ok
        ? {
            ok: false,
            status: 200,
            message: "the claim landed but its one-time lease token was not recoverable",
            ambiguous: true,
          }
        : result;
      return failOptimistic({
        result: failed,
        mutationId: id,
        fingerprint,
        chapterId: item?.chapterId ?? null,
        annotationId: item?.sourceAnnotationId ?? null,
        refreshWork: true,
        retainAmbiguous: true,
        rollback: () => {
          if (item !== undefined && !store.getState().workItemIds.includes(item.id)) {
            store.setState({ workItemIds: [...store.getState().workItemIds, item.id] });
          }
        },
      });
    }
    leaseSecrets.set(workItemId, {
      leaseId: result.value.lease.id,
      token: claimedToken,
    });
    const { token: _token, tokenRedacted: _redactedMarker, ...safeLease } = result.value.lease;
    const safe: SafeTaskBundle = { ...result.value, lease: safeLease };
    const claimInvalidationsByWorkItem = {
      ...store.getState().claimInvalidationsByWorkItem,
    };
    delete claimInvalidationsByWorkItem[workItemId];
    store.setState({
      activeClaimsByWorkItem: {
        ...store.getState().activeClaimsByWorkItem,
        [workItemId]: safe,
      },
      claimInvalidationsByWorkItem,
    });
    await settleAcceptedMutation(
      id,
      fingerprint,
      item?.chapterId ?? null,
      item?.sourceAnnotationId ?? null,
      true,
    );
    return { ok: true, value: safe };
  };

  const renewClaim = async (
    workItemId: string,
  ): Promise<StoreActionResult<LeaseRenewal>> => {
    const write = api.renewLease;
    const secret = leaseSecrets.get(workItemId);
    if (write === undefined) return unsupported("lease renewal");
    if (secret === undefined) return unsupported("active lease");
    const generation = authorizationGeneration;
    const fingerprint = commandFingerprint("lease.renew", workItemId, secret.leaseId);
    const key = retainedKeyFor(fingerprint);
    const result = await replayOnce(() =>
      write.call(api, workItemId, secret.leaseId, secret.token, {
        idempotencyKey: key,
      }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      if (!shouldReplay(result)) settleCommand(fingerprint);
      return actionFailure(result);
    }
    settleCommand(fingerprint);
    const claim = store.getState().activeClaimsByWorkItem[workItemId];
    if (claim !== undefined) {
      store.setState({
        activeClaimsByWorkItem: {
          ...store.getState().activeClaimsByWorkItem,
          [workItemId]: {
            ...claim,
            lease: {
              ...claim.lease,
              expiresAt: result.value.expiresAt,
              maxExpiresAt: result.value.maxExpiresAt,
              renewalPromptAt: result.value.renewalPromptAt,
            },
          },
        },
      });
    }
    return { ok: true, value: result.value };
  };

  const releaseClaim = async (
    workItemId: string,
  ): Promise<StoreActionResult<LeaseRelease>> => {
    const write = api.releaseLease;
    const secret = leaseSecrets.get(workItemId);
    if (write === undefined) return unsupported("lease release");
    const generation = authorizationGeneration;
    const fingerprint = commandFingerprint("lease.release", workItemId, secret?.leaseId ?? null);
    const key = retainedKeyFor(fingerprint);
    const result = await replayOnce(() =>
      write.call(api, workItemId, secret?.leaseId, { idempotencyKey: key }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      if (!shouldReplay(result)) settleCommand(fingerprint);
      return actionFailure(result);
    }
    settleCommand(fingerprint);
    leaseSecrets.delete(workItemId);
    leaseRecoveryCorrelations.delete(workItemId);
    const activeClaimsByWorkItem = { ...store.getState().activeClaimsByWorkItem };
    delete activeClaimsByWorkItem[workItemId];
    store.setState({ activeClaimsByWorkItem });
    await loadWorkItems(true);
    return { ok: true, value: result.value };
  };

  const submitClaim = async (
    workItemId: string,
    command: WorkSubmission,
  ): Promise<StoreActionResult<SubmissionAccepted>> => {
    const write = api.submitWork;
    const secret = leaseSecrets.get(workItemId);
    if (write === undefined) return unsupported("work submission");
    if (secret === undefined) return unsupported("active lease");
    const generation = authorizationGeneration;
    const claim = store.getState().activeClaimsByWorkItem[workItemId];
    const fingerprint = commandFingerprint("work.submit", workItemId, command);
    const key = retainedKeyFor(fingerprint);
    // Reuse the retained UUID as the request correlation. The server echoes it
    // in both the accepted response and `submission_received`, so this tab can
    // recognize its own event even when the feed wins the response race.
    const correlationId = key;
    const retainedSubmission = localSubmissionCommands.get(workItemId);
    if (retainedSubmission?.correlationId !== correlationId) {
      localSubmissionCommands.set(workItemId, { correlationId, fingerprint });
    }
    const result = await replayOnce(() =>
      write.call(
        api,
        workItemId,
        { ...command, leaseId: secret.leaseId, leaseToken: secret.token },
        { idempotencyKey: key, correlationId },
      ),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      const accepted = store.getState().submissionAcceptancesByWorkItem[workItemId];
      if (accepted?.correlationId === correlationId) {
        // The feed is authoritative evidence that this exact request landed.
        // Do not revive an already-consumed lease merely because both HTTP
        // responses were lost.
        settleCommand(fingerprint);
        localSubmissionCommands.delete(workItemId);
        await registerOperationContext(accepted.operationId, {
          kind: "submission.apply",
          chapterId: claim?.document.chapterId ?? null,
          workItemId,
        });
        return { ok: true, value: accepted };
      }
      if (!shouldReplay(result)) {
        settleCommand(fingerprint);
        const local = localSubmissionCommands.get(workItemId);
        if (local?.correlationId === correlationId) {
          localSubmissionCommands.delete(workItemId);
        }
      }
      return actionFailure(result);
    }
    settleCommand(fingerprint);
    consumeLocalClaim(workItemId);
    store.setState({
      submissionAcceptancesByWorkItem: {
        ...store.getState().submissionAcceptancesByWorkItem,
        [workItemId]: result.value,
      },
    });
    const local = localSubmissionCommands.get(workItemId);
    if (local?.correlationId === correlationId) {
      if (local.terminalEventSeen === true) {
        localSubmissionCommands.delete(workItemId);
      } else {
        localSubmissionCommands.set(workItemId, {
          ...local,
          correlationId: result.value.correlationId,
          submissionId: result.value.submissionId,
          operationId: result.value.operationId,
        });
      }
    }
    await registerOperationContext(result.value.operationId, {
      kind: "submission.apply",
      chapterId: claim?.document.chapterId ?? null,
      workItemId,
    });
    return { ok: true, value: result.value };
  };

  const readChapterSource = async (
    chapterId: string,
  ): Promise<StoreActionResult<ChapterSource>> => {
    const read = api.chapterSource;
    if (read === undefined) return unsupported("chapter source");
    const generation = authorizationGeneration;
    const result = await read.call(api, chapterId);
    if (generation !== authorizationGeneration) return credentialChanged();
    return result.ok ? { ok: true, value: result.value } : actionFailure(result);
  };

  const readRepositoryDocument = async (
    kind: RepositoryDocumentKind,
    path: string,
  ): Promise<StoreActionResult<RepositoryDocumentSource>> => {
    const read = api.repositoryDocumentSource;
    if (read === undefined) return unsupported("repository document source");
    const generation = authorizationGeneration;
    const result = await read.call(api, kind, path);
    if (generation !== authorizationGeneration) return credentialChanged();
    return result.ok ? { ok: true, value: result.value } : actionFailure(result);
  };

  const proposeRevision = async (
    command: CreateRevisionProposalCommand,
    fingerprintKind: "chapter" | "summary" | "document",
    chapterId: string | null,
  ): Promise<StoreActionResult<RevisionProposalAccepted>> => {
    const write = api.createRevisionProposal;
    if (write === undefined) return unsupported("revision proposal");
    const generation = authorizationGeneration;
    const fingerprint = commandFingerprint(`revision.propose-${fingerprintKind}`, command);
    const key = retainedKeyFor(fingerprint);
    const result = await replayOnce(() =>
      write.call(api, command, { idempotencyKey: key }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      if (!shouldReplay(result)) settleCommand(fingerprint);
      return actionFailure(result);
    }
    settleCommand(fingerprint);
    if (store.getState().revisionProposalsStatus !== "idle") {
      void loadRevisionProposals(true);
    }
    if (result.value.operationId !== null) {
      await registerOperationContext(result.value.operationId, {
        kind: "revision.apply",
        chapterId,
        workItemId: null,
        revisionProposalId: result.value.proposalId,
      });
    }
    return { ok: true, value: result.value };
  };

  const proposeRepositoryDocument = (
    command: RepositoryDocumentProposalCommand,
  ): Promise<StoreActionResult<RevisionProposalAccepted>> =>
    proposeRevision(command, "document", null);

  const proposeChapterRevision = (
    command: ChapterRevisionProposalCommand,
  ): Promise<StoreActionResult<RevisionProposalAccepted>> =>
    proposeRevision(command, "chapter", command.chapterId);

  const proposeChapterSummary = (
    command: ChapterSummaryProposalCommand,
  ): Promise<StoreActionResult<RevisionProposalAccepted>> =>
    proposeRevision(command, "summary", command.chapterId);

  const writeChapter = async (
    command: ChapterCreateCommand | ChapterReviseCommand,
  ): Promise<StoreActionResult<ChapterAccepted>> => {
    const revising = "chapterId" in command;
    const write = revising ? api.reviseChapter : api.createChapter;
    if (write === undefined) return unsupported("chapter writing");
    const generation = authorizationGeneration;
    const fingerprint = commandFingerprint("chapter.write", command);
    const key = retainedKeyFor(fingerprint);
    const result = await replayOnce(() =>
      revising
        ? (api.reviseChapter as NonNullable<ProjectStoreApi["reviseChapter"]>).call(
            api,
            command as ChapterReviseCommand,
            { idempotencyKey: key },
          )
        : (api.createChapter as NonNullable<ProjectStoreApi["createChapter"]>).call(
            api,
            command as ChapterCreateCommand,
            { idempotencyKey: key },
          ),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      if (!shouldReplay(result)) settleCommand(fingerprint);
      return actionFailure(result);
    }
    settleCommand(fingerprint);
    await registerOperationContext(result.value.operationId, {
      kind: "chapter.write",
      chapterId: result.value.chapterId,
      workItemId: null,
    });
    void loadChapters(true);
    return { ok: true, value: result.value };
  };

  const setChapterPublication = async (
    chapterId: string,
    published: boolean,
  ): Promise<StoreActionResult<ChapterAccepted>> => {
    const write = published ? api.publishChapter : api.unpublishChapter;
    if (write === undefined) return unsupported("chapter publication");
    const generation = authorizationGeneration;
    const fingerprint = commandFingerprint("chapter.publication", chapterId, published);
    const key = retainedKeyFor(fingerprint);
    const result = await replayOnce(() =>
      write.call(api, chapterId, { idempotencyKey: key }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      if (!shouldReplay(result)) settleCommand(fingerprint);
      if (result.status === 409) void loadChapters(true);
      return actionFailure(result);
    }
    settleCommand(fingerprint);
    await registerOperationContext(result.value.operationId, {
      kind: published ? "chapter.publish" : "chapter.unpublish",
      chapterId,
      workItemId: null,
    });
    return { ok: true, value: result.value };
  };

  const reviewRevision = async (
    proposalId: string,
    decision: "approve" | "reject",
    reason?: string,
  ): Promise<StoreActionResult<RevisionReviewResult>> => {
    const write = api.reviewRevisionProposal;
    if (write === undefined) return unsupported("revision review");
    const before = store.getState().revisionProposalsById[proposalId];
    if (before === undefined) {
      return {
        ok: false,
        kind: "rejected",
        status: 404,
        message: "revision proposal is not loaded",
      };
    }
    const generation = authorizationGeneration;
    const optimisticStatus = decision === "approve" ? "applying" : "rejected";
    store.setState({
      revisionProposalsById: {
        ...store.getState().revisionProposalsById,
        [proposalId]: { ...before, status: optimisticStatus },
      },
    });
    const fingerprint = commandFingerprint(
      "revision.review",
      proposalId,
      decision,
      reason?.trim() ?? "",
    );
    const key = retainedKeyFor(fingerprint);
    const result = await replayOnce(() =>
      write.call(api, proposalId, decision, reason, { idempotencyKey: key }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      store.setState({
        revisionProposalsById: {
          ...store.getState().revisionProposalsById,
          [proposalId]: before,
        },
      });
      if (!shouldReplay(result)) settleCommand(fingerprint);
      if (result.status === 409) {
        void loadRevisionProposals(true);
        void loadRevisionProposal(proposalId, true);
      }
      return actionFailure(result);
    }
    settleCommand(fingerprint);
    const current = store.getState().revisionProposalsById[proposalId] ?? before;
    store.setState({
      revisionProposalsById: {
        ...store.getState().revisionProposalsById,
        [proposalId]: {
          ...current,
          status: result.value.status || optimisticStatus,
          ...(result.value.operationId === undefined
            ? {}
            : { gitOperationId: result.value.operationId }),
        },
      },
    });
    if (result.value.operationId !== undefined) {
      await registerOperationContext(result.value.operationId, {
        kind: "revision.apply",
        chapterId: before.chapterId,
        workItemId: before.workItemId,
        refreshWork: before.workItemId !== null,
        revisionProposalId: proposalId,
      });
    }
    return { ok: true, value: result.value };
  };

  const restoreChapterHistory = async (
    chapterId: string,
    revision: number,
  ): Promise<StoreActionResult<ChapterHistoryRestoreAccepted>> => {
    const write = api.restoreChapterRevision;
    if (write === undefined) return unsupported("chapter history restore");
    const generation = authorizationGeneration;
    const fingerprint = commandFingerprint("chapter.history.restore", chapterId, revision);
    const key = retainedKeyFor(fingerprint);
    const result = await replayOnce(() =>
      write.call(api, chapterId, revision, { idempotencyKey: key }),
    );
    if (generation !== authorizationGeneration) return credentialChanged();
    if (!result.ok) {
      if (!shouldReplay(result)) settleCommand(fingerprint);
      if (result.status === 409) {
        void loadChapterHistory(chapterId, true);
      }
      return actionFailure(result);
    }
    settleCommand(fingerprint);
    if (store.getState().revisionProposalsStatus !== "idle") {
      void loadRevisionProposals(true);
    }
    return { ok: true, value: result.value };
  };

  store = createStore<ProjectStoreState>()(() => ({
    project: { ...config },
    session: null,
    sessionStatus: "idle",
    sessionError: null,
    chaptersById: {},
    chapterIds: [],
    chaptersStatus: "idle",
    chaptersError: null,
    annotationsById: {},
    annotationIdsByChapter: {},
    annotationStatusByChapter: {},
    annotationErrorByChapter: {},
    repliesById: {},
    replyIdsByAnnotation: {},
    replyStatusByAnnotation: {},
    replyErrorByAnnotation: {},
    replyErrorStatusByAnnotation: {},
    workItemsById: {},
    workItemIds: [],
    workItemsStatus: "idle",
    workItemsError: null,
    completedWorkItemsById: {},
    completedWorkItemIds: [],
    completedWorkItemsStatus: "idle",
    completedWorkItemsError: null,
    completedWorkItemsNextCursor: null,
    revisionProposalsById: {},
    revisionProposalIds: [],
    revisionProposalsStatus: "idle",
    revisionProposalsError: null,
    revisionProposalDetailStatusById: {},
    revisionProposalDetailErrorById: {},
    chapterHistoryByChapter: {},
    chapterHistoryStatusByChapter: {},
    chapterHistoryErrorByChapter: {},
    chapterHistoryDetailByKey: {},
    chapterHistoryDetailStatusByKey: {},
    chapterHistoryDetailErrorByKey: {},
    operationsById: {},
    pendingMutations: {},
    activeClaimsByWorkItem: {},
    claimInvalidationsByWorkItem: {},
    submissionAcceptancesByWorkItem: {},
    connection: {
      transport: "none",
      status: "idle",
      cursor: 0,
      lastError: null,
    },
    ensureSession: () => loadSession(false),
    refreshSession: (credentialChanged = false) => loadSession(true, credentialChanged),
    ensureChapters: () => loadChapters(false),
    refreshChapters: () => loadChapters(true),
    ensureAnnotations: (chapterId) => loadAnnotations(chapterId, false),
    refreshAnnotations: (chapterId) => loadAnnotations(chapterId, true),
    ensureReplies: (annotationId) => loadReplies(annotationId, false),
    refreshReplies: (annotationId) => loadReplies(annotationId, true),
    ensureWorkItems: () => loadWorkItems(false),
    refreshWorkItems: () => loadWorkItems(true),
    ensureCompletedWorkItems: () => loadCompletedWorkItems("ensure"),
    refreshCompletedWorkItems: () => loadCompletedWorkItems("refresh"),
    loadMoreCompletedWorkItems: () => loadCompletedWorkItems("more"),
    ensureRevisionProposals: () => loadRevisionProposals(false),
    refreshRevisionProposals: () => loadRevisionProposals(true),
    ensureRevisionProposal: (proposalId) => loadRevisionProposal(proposalId, false),
    refreshRevisionProposal: (proposalId) => loadRevisionProposal(proposalId, true),
    ensureChapterHistory: (chapterId) => loadChapterHistory(chapterId, false),
    refreshChapterHistory: (chapterId) => loadChapterHistory(chapterId, true),
    ensureChapterHistoryRevision: (chapterId, revision, compare) =>
      loadChapterHistoryRevision(chapterId, revision, compare, false),
    refreshChapterHistoryRevision: (chapterId, revision, compare) =>
      loadChapterHistoryRevision(chapterId, revision, compare, true),
    refreshOperation: async (operationId) => {
      const generation = authorizationGeneration;
      const operation = (await api.operation?.(operationId)) ?? null;
      if (generation !== authorizationGeneration) return null;
      if (operation !== null) {
        store.setState({
          operationsById: {
            ...store.getState().operationsById,
            [operationId]: operation,
          },
        });
        await settleOperationContext(operationId, operation);
      }
      return operation;
    },
    retainConnection: () => {
      connectionUsers += 1;
      void startEvents();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        connectionUsers = Math.max(0, connectionUsers - 1);
        if (connectionUsers === 0) {
          clearConnectionRetry();
          connectionFailures = 0;
          authoritativeReady = false;
          transportConnected = false;
          events?.stop();
          events = null;
          store.setState({
            connection: {
              ...store.getState().connection,
              transport: "none",
              status: "idle",
            },
          });
        }
      };
    },
    reconcileEvent: refreshForEvent,
    createAnnotation,
    createReply,
    withdrawAnnotation,
    withdrawReply,
    setVote,
    promoteAnnotation: (annotationId) => overrideAnnotation(annotationId, "promote"),
    rejectAnnotation: (annotationId, reason) =>
      overrideAnnotation(annotationId, "reject", reason),
    reviewRevision,
    restoreChapterHistory,
    claimWork,
    recoverClaim,
    forgetClaim: (workItemId) => clearLocalClaim(workItemId),
    renewClaim,
    releaseClaim,
    submitClaim,
    readChapterSource,
    readRepositoryDocument,
    proposeRepositoryDocument,
    proposeChapterRevision,
    proposeChapterSummary,
    createChapter: (command) => writeChapter(command),
    reviseChapter: (command) => writeChapter(command),
    setChapterPublication,
  }));
  return store;
}

const PROJECT_STORES = Symbol.for("authorbot.project-stores.v1");

function projectStoreRegistry(): Map<string, ProjectStore> {
  const root = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = root[PROJECT_STORES];
  if (existing instanceof Map) {
    return existing as Map<string, ProjectStore>;
  }
  const created = new Map<string, ProjectStore>();
  root[PROJECT_STORES] = created;
  return created;
}

/** One in-memory store per API base and project for the lifetime of the page. */
export function getProjectStore(config: ProjectStoreConfig): ProjectStore {
  const key = JSON.stringify([config.apiBase, config.project]);
  const stores = projectStoreRegistry();
  const existing = stores.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = createProjectStore(config);
  stores.set(key, created);
  return created;
}

/** Test isolation for the module-level page registry. */
export function resetProjectStoresForTests(): void {
  projectStoreRegistry().clear();
}
