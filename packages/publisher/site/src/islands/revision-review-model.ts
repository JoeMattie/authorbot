import type {
  RevisionProposalDetail,
  RevisionProposalSummary,
} from "./api.js";

/**
 * Document-neutral view model shared by chapter review today and the future
 * Outline, Timeline, and Character revision surfaces.
 */
export interface RevisionReviewDocument {
  kind: string;
  id: string;
  path: string;
  label: string;
  currentRevision: number | null;
}

export interface RevisionReviewWarning {
  tone: "conflict" | "moved" | "unknown";
  message: string;
}

export interface RevisionReviewActionCopy {
  approveLabel: string;
  explanation: string;
}

/** Prefer the generic target, retaining chapter fields for older APIs. */
export function revisionDocument(proposal: RevisionProposalSummary): RevisionReviewDocument {
  if (proposal.target != null) {
    return {
      ...proposal.target,
      currentRevision: proposal.currentRevision ?? null,
    };
  }
  if (proposal.chapter != null) {
    return {
      kind: "chapter",
      id: proposal.chapter.id,
      path: proposal.chapter.path ?? "",
      label: proposal.chapter.title,
      currentRevision: proposal.currentRevision ?? proposal.chapter.revision,
    };
  }
  return {
    kind: "chapter",
    id: proposal.chapterId ?? proposal.id,
    path: "",
    label: "Chapter revision",
    currentRevision: proposal.currentRevision ?? null,
  };
}

export function revisionWarning(
  proposal: RevisionProposalSummary,
): RevisionReviewWarning | null {
  const document = revisionDocument(proposal);
  if (proposal.status === "conflicted") {
    return {
      tone: "conflict",
      message:
        "This proposal conflicted and did not change the current document. Review the current version before trying again.",
    };
  }
  if (proposal.conflictWarning === true) {
    return {
      tone: "moved",
      message:
        document.currentRevision === null
          ? "The current document no longer matches this proposal's base. Applying will validate the change and will not silently overwrite newer content."
          : `The current document at revision ${document.currentRevision} no longer matches this proposal's base revision ${proposal.baseRevision}. Applying will validate the change and may create a conflict; it will not overwrite the current version silently.`,
    };
  }
  // Repository documents are content-hash versioned rather than carrying a
  // synthetic chapter revision. A matching hash is a known-good current base,
  // not an "unavailable revision" warning.
  if (document.kind !== "chapter" || proposal.baseRevision === null) {
    return null;
  }
  if (document.currentRevision === null) {
    return {
      tone: "unknown",
      message:
        "The current document revision is unavailable. Applying still performs the server-side base check and will not silently overwrite newer content.",
    };
  }
  if (document.currentRevision !== proposal.baseRevision) {
    return {
      tone: "moved",
      message:
        `This proposal was written against revision ${proposal.baseRevision}, but the current ` +
        `document is revision ${document.currentRevision}. Applying will validate the change and may create a conflict; it will not overwrite the current version silently.`,
    };
  }
  return null;
}

/** Maintainer-authored direct edits are deliberately one click, not self-review theatre. */
export function revisionActionCopy(
  proposal: RevisionProposalSummary,
): RevisionReviewActionCopy {
  return proposal.origin === "direct_edit" || proposal.origin === "document_edit"
    ? {
        approveLabel: "Apply changes",
        explanation:
          "This is a maintainer direct edit. One click records the review and applies it through the same validated Git and deployment path.",
      }
    : {
        approveLabel: "Approve and apply",
        explanation:
          "Approval applies this proposal through the validated Git path. The published site updates after the resulting deployment lands.",
      };
}

export function revisionStatusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export function workTypeLabel(type: string): string {
  return type.replaceAll("_", " ");
}

export function isRevisionProposalDetail(
  proposal: RevisionProposalSummary,
): proposal is RevisionProposalDetail {
  return (
    "baseContent" in proposal &&
    "proposedContent" in proposal &&
    "diff" in proposal
  );
}
