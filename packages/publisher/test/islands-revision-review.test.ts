// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RevisionProposalDetail,
  RevisionProposalSummary,
} from "../site/src/islands/api.js";
import {
  getProjectStore,
  resetProjectStoresForTests,
} from "../site/src/islands/project-store.js";
import { AuthorbotRevisionReview } from "../site/src/islands/revision-review.js";

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const PROPOSAL = "proposal-1";
const DIRECT = "proposal-2";

if (customElements.get("authorbot-revision-review") === undefined) {
  customElements.define("authorbot-revision-review", AuthorbotRevisionReview);
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

function summary(
  id: string,
  overrides: Partial<RevisionProposalSummary> = {},
): RevisionProposalSummary {
  return {
    id,
    projectId: PROJECT,
    chapterId: "chapter-1",
    proposalType: "chapter_replacement",
    origin: "work_submission",
    workItemId: "work-1",
    submissionId: "submission-1",
    authorActorId: "actor-agent",
    baseRevision: 4,
    changeSummary: "Make the ending quieter.",
    notes: "Preserve the final image.",
    status: "pending_review",
    reviewedByActorId: null,
    reviewedAt: null,
    reviewReason: null,
    gitOperationId: null,
    resultingRevision: null,
    commitSha: null,
    createdAt: "2026-07-22T18:00:00Z",
    updatedAt: "2026-07-22T18:00:00Z",
    currentRevision: 6,
    target: {
      kind: "chapter",
      id: "chapter-1",
      path: "chapters/01-signal.md",
      label: "Signal",
    },
    author: { id: "actor-agent", displayName: "Line Editor", type: "agent" },
    workItem: { id: "work-1", type: "revise_chapter", status: "submitted" },
    chapter: {
      id: "chapter-1",
      title: "Signal",
      path: "chapters/01-signal.md",
      revision: 6,
    },
    ...overrides,
  };
}

function detail(
  id: string,
  overrides: Partial<RevisionProposalSummary> = {},
): RevisionProposalDetail {
  return {
    ...summary(id, overrides),
    baseContentHash: "sha256:before",
    baseContent: "Before ending.\n",
    proposedContent: "After ending.\n",
    diff: { unifiedDiff: null, computationLimited: true },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubApi(options: {
  role?: string;
  scopes?: string[];
  proposals?: RevisionProposalSummary[];
  linkedProposals?: RevisionProposalSummary[];
} = {}): void {
  const proposals = options.proposals ?? [summary(PROPOSAL)];
  const linkedProposals = options.linkedProposals ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === `${API}/v1/me`) {
        return json(200, {
          actor: { id: "maintainer-1", displayName: "Mara", externalIdentity: "github:mara" },
          memberships: [{ role: options.role ?? "maintainer" }],
          scopes: options.scopes ?? ["revisions:read", "revisions:review"],
        });
      }
      if (url.includes("/events?")) return json(404, { detail: "event feed unavailable" });
      if (url.includes("/revision-proposals?")) {
        return json(200, { items: proposals, nextCursor: null });
      }
      const selected = [...proposals, ...linkedProposals]
        .find((proposal) => url.includes(proposal.id));
      if (method === "GET" && selected !== undefined) {
        return json(200, detail(selected.id, selected));
      }
      if (url.endsWith("/approve")) {
        return json(202, {
          proposalId: selected?.id ?? DIRECT,
          status: "applying",
          correlationId: "correlation-approve",
          operationId: "operation-approve",
        });
      }
      if (url.endsWith("/reject")) {
        return json(200, {
          proposalId: selected?.id ?? PROPOSAL,
          status: "rejected",
          correlationId: "correlation-reject",
        });
      }
      return json(404, { detail: "not found" });
    }),
  );
}

function mount(): AuthorbotRevisionReview {
  const element = document.createElement(
    "authorbot-revision-review",
  ) as AuthorbotRevisionReview;
  element.dataset.apiBase = API;
  element.dataset.project = PROJECT;
  element.dataset.base = "/book/";
  const fallback = document.createElement("p");
  fallback.className = "revision-fallback";
  fallback.textContent = "Revision proposals load here once JavaScript is enabled.";
  element.append(fallback);
  document.body.append(element);
  return element;
}

beforeEach(() => {
  calls = [];
  document.body.textContent = "";
  window.history.replaceState(null, "", "/revisions/");
  resetProjectStoresForTests();
});

afterEach(() => {
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

describe("maintainer revision review element", () => {
  it("shows author/Work attribution, a moved-base warning, and a direct visual diff", async () => {
    stubApi();
    mount();

    await expect.poll(() => document.querySelector(".ab-revision-detail h2")?.textContent).toBe(
      "Signal",
    );
    expect(document.querySelector(".ab-revision-detail")?.textContent).toContain("Line Editor");
    expect(document.querySelector(".ab-revision-work")?.textContent).toBe(
      "Work · revise chapter",
    );
    expect(document.querySelector<HTMLAnchorElement>(".ab-revision-work")?.pathname).toBe(
      "/book/work/",
    );
    expect(document.querySelector(".ab-revision-warning-moved")?.textContent).toContain(
      "current document is revision 6",
    );
    expect(document.querySelector(".ab-revision-diff")?.getAttribute("role")).toBe("group");
    expect(document.querySelector(".ab-revision-diff-fallback")).toBeNull();
  });

  it("presents maintainer direct edits as one-click Apply changes", async () => {
    const direct = summary(DIRECT, {
      origin: "direct_edit",
      workItemId: null,
      submissionId: null,
      workItem: null,
      currentRevision: 4,
      changeSummary: "Direct line edit.",
    });
    stubApi({ proposals: [direct] });
    mount();

    await expect.poll(
      () => document.querySelector<HTMLButtonElement>(".ab-revision-approve"),
    ).toBeTruthy();
    expect(document.querySelector(".ab-revision-approve")?.textContent).toBe("Apply changes");
    expect(document.querySelector(".ab-revision-action-copy")?.textContent).toContain(
      "One click",
    );
    document.querySelector<HTMLButtonElement>(".ab-revision-approve")?.click();

    await expect.poll(() => document.querySelector(".ab-revision-result-applying")?.textContent).toContain(
      "validated Git write is in progress",
    );
    const approveCall = calls.find((call) => call.url.endsWith(`/${DIRECT}/approve`));
    expect(approveCall).toMatchObject({ method: "POST", body: {} });
  });

  it("opens an exact linked proposal even when it is not in the pending queue", async () => {
    const completed = summary(DIRECT, {
      status: "approved",
      target: {
        kind: "chapter",
        id: "chapter-archive",
        path: "chapters/02-archive.md",
        label: "Archive",
      },
      chapter: {
        id: "chapter-archive",
        title: "Archive",
        path: "chapters/02-archive.md",
        revision: 8,
      },
      currentRevision: 8,
      resultingRevision: 8,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    window.history.replaceState(null, "", `/revisions/?proposal=${DIRECT}`);
    stubApi({ proposals: [summary(PROPOSAL)], linkedProposals: [completed] });
    mount();

    await expect.poll(() => document.querySelector(".ab-revision-detail h2")?.textContent)
      .toBe("Archive");
    expect(calls.some(({ url }) => url.includes(`/revision-proposals/${DIRECT}`))).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>(
        `.ab-revision-list-button[data-proposal-id="${DIRECT}"]`,
      )?.getAttribute("aria-current"),
    ).toBe("true");
  });

  it("reviews hash-versioned planning documents without inventing a null revision", async () => {
    const planning = summary(DIRECT, {
      chapterId: null,
      proposalType: "repository_document",
      origin: "document_edit",
      workItemId: null,
      submissionId: null,
      workItem: null,
      chapter: null,
      baseRevision: null,
      currentRevision: null,
      currentContentHash: "sha256:current-document-hash",
      target: {
        kind: "timeline",
        id: "timeline",
        path: "story/timeline.yml",
        label: "Timeline",
      },
    });
    stubApi({ proposals: [planning] });
    mount();

    await expect.poll(() => document.querySelector(".ab-revision-detail h2")?.textContent)
      .toBe("Timeline");
    const text = document.querySelector(".ab-revision-detail")?.textContent ?? "";
    expect(text).toContain("Base contentsha256:before…");
    expect(text).toContain("Current contentsha256:current-docu…");
    expect(text).not.toContain("Base revisionnull");
    expect(document.querySelector(".ab-revision-warning")).toBeNull();
    expect(document.querySelector(".ab-revision-approve")?.textContent).toBe("Apply changes");
  });

  it("preserves a typed rejection draft and focus across store updates", async () => {
    stubApi();
    mount();

    await expect.poll(
      () => document.querySelector<HTMLTextAreaElement>(".ab-revision-reason"),
    ).toBeTruthy();
    const original = document.querySelector<HTMLTextAreaElement>(".ab-revision-reason")!;
    original.value = "The last image needs one more beat.";
    original.dispatchEvent(new Event("input", { bubbles: true }));
    original.focus();

    const store = getProjectStore({ apiBase: API, project: PROJECT });
    store.setState({
      connection: {
        transport: "sse",
        status: "live",
        cursor: 42,
        lastError: null,
      },
    });

    // Connection cursors and unrelated SSE-backed slices must not rebuild a
    // live decision form or steal its keyboard focus.
    expect(document.querySelector(".ab-revision-reason")).toBe(original);
    expect(original.value).toBe("The last image needs one more beat.");
    expect(document.activeElement).toBe(original);

    const current = store.getState().revisionProposalsById[PROPOSAL]!;
    store.setState({
      revisionProposalsById: {
        ...store.getState().revisionProposalsById,
        [PROPOSAL]: { ...current, updatedAt: "2026-07-22T18:01:00Z" },
      },
    });

    // An authoritative proposal change may rebuild the detail, but local
    // unsent text and focus still belong to the maintainer.
    const replacement = document.querySelector<HTMLTextAreaElement>(".ab-revision-reason")!;
    expect(replacement).not.toBe(original);
    expect(replacement.value).toBe("The last image needs one more beat.");
    expect(document.activeElement).toBe(replacement);
  });

  it("does not require a rejection note and withholds decisions without review authority", async () => {
    stubApi();
    mount();
    await expect.poll(
      () => document.querySelector<HTMLButtonElement>(".ab-revision-reject"),
    ).toBeTruthy();
    document.querySelector<HTMLButtonElement>(".ab-revision-reject")?.click();
    await expect.poll(() => document.querySelector(".ab-revision-result-rejected")?.textContent).toContain(
      "current document was not changed",
    );
    expect(calls.find((call) => call.url.endsWith(`/${PROPOSAL}/reject`))).toMatchObject({
      method: "POST",
      body: {},
    });

    document.body.textContent = "";
    resetProjectStoresForTests();
    calls = [];
    stubApi({ role: "editor", scopes: ["revisions:read"] });
    mount();
    await expect.poll(() => document.querySelector(".ab-revision-permission")?.textContent).toContain(
      "maintainer",
    );
    expect(document.querySelector(".ab-revision-approve")).toBeNull();
    expect(document.querySelector(".ab-revision-reject")).toBeNull();
  });
});
