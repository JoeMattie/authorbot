import type {
  FeedEvent,
  Operation,
  RepositoryDocumentKind,
  RevisionProposalAccepted,
  RevisionProposalSummary,
} from "./api.js";

/** One editor target. Keys are stable across custom-element remounts. */
export interface EditorRevisionTarget {
  key: string;
  kind: "chapter" | RepositoryDocumentKind;
  chapterId: string | null;
  path: string | null;
}

export function chapterEditorRevisionTarget(chapterId: string): EditorRevisionTarget {
  return {
    key: `chapter:${chapterId}`,
    kind: "chapter",
    chapterId,
    path: null,
  };
}

export function repositoryEditorRevisionTarget(
  kind: RepositoryDocumentKind,
  path: string,
): EditorRevisionTarget {
  return {
    key: `repository:${kind}:${path}`,
    kind,
    chapterId: null,
    path,
  };
}

export type EditorRevisionPhase =
  | "saving"
  | "save_failed"
  | "pending_review"
  | "rejected"
  | "applying"
  | "apply_failed"
  | "integrated"
  | "publishing"
  | "deployment_failed"
  | "deployed";

export interface EditorPublicationState {
  integratedCommit: string;
  buildStatus: string;
  deployedCommit: string | null;
}

/**
 * Durable server progress for one in-page editor. Proposed text deliberately
 * stays in sessionStorage; the shared store only owns identifiers and status.
 */
export interface EditorRevisionState {
  target: EditorRevisionTarget;
  proposalId: string | null;
  operationId: string | null;
  correlationId: string | null;
  phase: EditorRevisionPhase;
  error: string | null;
  commitSha: string | null;
  publication: EditorPublicationState | null;
}

const EDITOR_PHASE_ORDER: Readonly<Record<EditorRevisionPhase, number>> = {
  saving: 0,
  save_failed: 0,
  pending_review: 1,
  applying: 2,
  rejected: 2,
  apply_failed: 2,
  integrated: 3,
  publishing: 4,
  deployment_failed: 4,
  deployed: 5,
};

function advancedPhase(
  current: EditorRevisionPhase,
  proposed: EditorRevisionPhase,
): EditorRevisionPhase {
  if (current === "rejected" || current === "apply_failed" || current === "deployed") {
    return current;
  }
  return EDITOR_PHASE_ORDER[proposed] < EDITOR_PHASE_ORDER[current] ? current : proposed;
}

/**
 * Apply a phase transition without letting an older response erase the more
 * useful error/status already learned from the event stream or a later read.
 */
function editorPhaseUpdate(
  state: EditorRevisionState,
  proposed: EditorRevisionPhase,
  error: string | null,
): Pick<EditorRevisionState, "phase" | "error"> {
  const phase = advancedPhase(state.phase, proposed);
  return {
    phase,
    error: phase === proposed ? error : state.error,
  };
}

export interface ResumeEditorRevision {
  proposalId: string;
  operationId?: string | null;
  correlationId?: string | null;
  commitSha?: string | null;
  phase?: EditorRevisionPhase;
  error?: string | null;
}

const EDITOR_REVISION_PHASES: ReadonlySet<string> = new Set<EditorRevisionPhase>([
  "saving",
  "save_failed",
  "pending_review",
  "rejected",
  "applying",
  "apply_failed",
  "integrated",
  "publishing",
  "deployment_failed",
  "deployed",
]);

export function isEditorRevisionPhase(value: unknown): value is EditorRevisionPhase {
  return typeof value === "string" && EDITOR_REVISION_PHASES.has(value);
}

export function beginEditorRevision(
  target: EditorRevisionTarget,
  correlationId: string,
): EditorRevisionState {
  return {
    target,
    proposalId: null,
    operationId: null,
    correlationId,
    phase: "saving",
    error: null,
    commitSha: null,
    publication: null,
  };
}

export function resumeEditorRevision(
  target: EditorRevisionTarget,
  input: ResumeEditorRevision,
): EditorRevisionState {
  return {
    target,
    proposalId: input.proposalId,
    operationId: input.operationId ?? null,
    correlationId: input.correlationId ?? null,
    phase: input.phase ?? (input.commitSha !== undefined && input.commitSha !== null
      ? "integrated"
      : input.operationId === undefined || input.operationId === null
        ? "pending_review"
        : "applying"),
    error: input.error ?? null,
    commitSha: input.commitSha ?? null,
    publication: null,
  };
}

export function failEditorRevisionSave(
  state: EditorRevisionState,
  error: string,
): EditorRevisionState {
  if (state.proposalId !== null || state.phase !== "saving") return state;
  return { ...state, phase: "save_failed", error };
}

export function acceptEditorRevision(
  state: EditorRevisionState,
  accepted: RevisionProposalAccepted,
): EditorRevisionState {
  const responsePhase = accepted.status === "applying" || accepted.operationId !== null
    ? "applying"
    : "pending_review";
  return {
    ...state,
    proposalId: accepted.proposalId,
    operationId: accepted.operationId,
    correlationId: accepted.correlationId,
    ...editorPhaseUpdate(state, responsePhase, null),
  };
}

function proposalIdFromEvent(event: FeedEvent): string | null {
  const candidate = event.payload["revisionProposalId"] ?? event.payload["proposalId"];
  return typeof candidate === "string" ? candidate : null;
}

export function reconcileEditorRevisionEvent(
  state: EditorRevisionState,
  event: FeedEvent,
): EditorRevisionState {
  const proposalId = proposalIdFromEvent(event);
  const correlationId = typeof event.payload["correlationId"] === "string"
    ? event.payload["correlationId"]
    : null;
  const matchesProposal = proposalId !== null && proposalId === state.proposalId;
  const matchesSavingCommand = state.proposalId === null && correlationId !== null &&
    correlationId === state.correlationId;
  if (!matchesProposal && !matchesSavingCommand) return state;

  const operationId = typeof event.payload["operationId"] === "string"
    ? event.payload["operationId"]
    : state.operationId;
  if (event.type === "revision_proposal_created") {
    // An immediate-apply approval event can beat its HTTP response. Never
    // regress a state that has already moved beyond creation.
    return {
      ...state,
      proposalId: proposalId ?? state.proposalId,
      correlationId: correlationId ?? state.correlationId,
      ...editorPhaseUpdate(state, "pending_review", null),
    };
  }
  if (event.type === "revision_proposal_approved") {
    return {
      ...state,
      proposalId: proposalId ?? state.proposalId,
      operationId,
      correlationId: correlationId ?? state.correlationId,
      ...editorPhaseUpdate(state, "applying", null),
    };
  }
  if (event.type === "revision_proposal_rejected") {
    return {
      ...state,
      proposalId: proposalId ?? state.proposalId,
      correlationId: correlationId ?? state.correlationId,
      ...editorPhaseUpdate(
        state,
        "rejected",
        "The revision was rejected. The submitted draft is still available.",
      ),
    };
  }
  if (event.type === "revision_proposal_applied") {
    const commitSha = typeof event.payload["commitSha"] === "string"
      ? event.payload["commitSha"]
      : state.commitSha;
    return {
      ...state,
      proposalId: proposalId ?? state.proposalId,
      ...editorPhaseUpdate(state, "integrated", null),
      commitSha,
    };
  }
  return state;
}

export function reconcileEditorRevisionProposal(
  state: EditorRevisionState,
  proposal: RevisionProposalSummary,
): EditorRevisionState {
  if (proposal.id !== state.proposalId) return state;
  const operationId = proposal.gitOperationId ?? proposal.operationId ?? state.operationId;
  const base = {
    ...state,
    operationId,
    commitSha: proposal.commitSha ?? state.commitSha,
  };
  if (proposal.status === "pending_review") {
    return { ...base, ...editorPhaseUpdate(state, "pending_review", null) };
  }
  if (proposal.status === "rejected") {
    return {
      ...base,
      ...editorPhaseUpdate(
        state,
        "rejected",
        proposal.reviewReason?.trim() ||
          "The revision was rejected. The submitted draft is still available.",
      ),
    };
  }
  if (proposal.status === "applying") {
    return { ...base, ...editorPhaseUpdate(state, "applying", null) };
  }
  if (proposal.status === "conflicted") {
    return {
      ...base,
      ...editorPhaseUpdate(
        state,
        "apply_failed",
        "The revision could not be applied. The submitted draft is still available.",
      ),
    };
  }
  if (proposal.status === "approved") {
    const proposedPhase = proposal.commitSha === null ? "applying" : "integrated";
    return {
      ...base,
      ...editorPhaseUpdate(state, proposedPhase, null),
    };
  }
  return base;
}

export function reconcileEditorRevisionOperation(
  state: EditorRevisionState,
  operation: Operation,
): EditorRevisionState {
  if (state.operationId !== operation.id) return state;
  if (operation.state === "failed") {
    return {
      ...state,
      ...editorPhaseUpdate(
        state,
        "apply_failed",
        operation.error?.trim() ||
          "The revision could not be applied. The submitted draft is still available.",
      ),
    };
  }
  if (operation.state === "committed" || operation.state === "verified") {
    return {
      ...state,
      ...editorPhaseUpdate(state, "integrated", null),
      commitSha: operation.commitSha ?? state.commitSha,
    };
  }
  return state;
}

export function publicationStateFromEvent(event: FeedEvent): EditorPublicationState | null {
  if (event.type !== "publication_updated") return null;
  const integratedCommit = event.payload["integratedCommit"];
  const buildStatus = event.payload["buildStatus"];
  const deployedCommit = event.payload["deployedCommit"];
  if (
    typeof integratedCommit !== "string" ||
    typeof buildStatus !== "string" ||
    (deployedCommit !== null && typeof deployedCommit !== "string")
  ) {
    return null;
  }
  return { integratedCommit, buildStatus, deployedCommit };
}

export function reconcileEditorRevisionPublication(
  state: EditorRevisionState,
  publication: EditorPublicationState,
): EditorRevisionState {
  if (
    state.commitSha === null ||
    (publication.integratedCommit !== state.commitSha &&
      publication.deployedCommit !== state.commitSha)
  ) {
    return state;
  }
  if (publication.deployedCommit === state.commitSha) {
    return {
      ...state,
      ...editorPhaseUpdate(state, "deployed", null),
      publication,
    };
  }
  if (publication.buildStatus === "failed") {
    return {
      ...state,
      ...editorPhaseUpdate(
        state,
        "deployment_failed",
        "Publication failed. The currently published content is still live.",
      ),
      publication,
    };
  }
  return {
    ...state,
    ...editorPhaseUpdate(state, "publishing", null),
    publication,
  };
}

/** Human-facing lifecycle copy shared by chapter and planning editors. */
export function editorRevisionMessage(
  state: EditorRevisionState,
  label: string,
): string {
  switch (state.phase) {
    case "saving":
      return `Saving ${label} changes…`;
    case "save_failed":
      return `The changes could not be saved. Your draft is still here. ${state.error ?? ""}`.trim();
    case "pending_review":
      return `Revision submitted and pending review. The published ${label} is unchanged.`;
    case "rejected":
      return `Revision rejected. Your submitted ${label} draft is still available to edit.`;
    case "applying":
      return `Revision approved and applying. The published ${label} stays unchanged until deployment.`;
    case "apply_failed":
      return `The revision could not be applied. Your submitted ${label} draft is still available.`;
    case "integrated":
      return `Changes are in the repository and waiting for publication. The published ${label} is unchanged.`;
    case "publishing": {
      const build = state.publication?.buildStatus;
      return build === "succeeded"
        ? `Publication succeeded and deployment is being confirmed. The published ${label} is unchanged until then.`
        : `Publishing ${label} changes${build === undefined ? "" : ` (${build})`}…`;
    }
    case "deployment_failed":
      return `Publication failed. The currently published ${label} is still live.`;
    case "deployed":
      return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)} changes are deployed. Refresh to view the published version.`;
  }
}

export function editorRevisionNeedsRecoveryWarning(
  state: EditorRevisionState | undefined,
): boolean {
  return state?.phase === "save_failed" || state?.phase === "rejected" ||
    state?.phase === "apply_failed";
}
