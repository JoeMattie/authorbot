import type {
  AnnotationRecord,
  ReplyRecord,
  WorkItemRecord,
  WorkItemStatus,
} from "@authorbot/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAPTER_ID,
  devLogin,
  makeHarness,
  mintCanonicalToken,
  mintToken,
  type TestHarness,
} from "./helpers.js";
import { uuidv7 } from "../src/ids.js";

const CHAPTER_2 = "01900000-0000-7000-8000-000000000002";
const NOW = "2026-07-22T18:00:00Z";
const ACTIVE_WORK_ITEM_STATUSES = [
  "ready",
  "leased",
  "submitted",
  "applying",
  "conflict",
] as const satisfies readonly WorkItemStatus[];
const ALL_WORK_ITEM_STATUSES = [
  ...ACTIVE_WORK_ITEM_STATUSES,
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly WorkItemStatus[];

type Activity = Partial<{
  openSuggestions: number;
  openBlockComments: number;
  openChapterComments: number;
  openReplies: number;
  openWorkItems: number;
}>;

interface ChapterPage {
  items: Array<{
    id: string;
    summary: string | null;
    order: number | null;
    status: string;
    activity: Activity;
  }>;
  nextCursor: string | null;
}

describe("chapter-list activity summaries", () => {
  let h: TestHarness;
  let maintainer: string;

  beforeEach(async () => {
    h = await makeHarness();
    maintainer = await devLogin(h, "activity-owner", "maintainer");
    await seedActivity(h);
  });

  afterEach(() => h.close());

  it("counts only open readable feedback, replies, and non-terminal Work", async () => {
    const response = await listChapters(h, { Cookie: maintainer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChapterPage;

    expect(body.items.map((chapter) => chapter.id)).toEqual([CHAPTER_ID, CHAPTER_2]);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]?.activity).toEqual({
      openSuggestions: 2,
      openBlockComments: 2,
      openChapterComments: 1,
      openReplies: 4,
      openWorkItems: 5,
    });
    expect(body.items[1]?.activity).toEqual({
      openSuggestions: 0,
      openBlockComments: 0,
      openChapterComments: 0,
      openReplies: 0,
      openWorkItems: 0,
    });

    const internal = await h.repos.chapters.listSummariesByProject(
      h.projectId,
      ACTIVE_WORK_ITEM_STATUSES,
      { limit: 2 },
    );
    expect(internal.items[0]?.activity).toEqual(
      expect.objectContaining({
        openCommentReplies: 3,
        openSuggestionReplies: 1,
      }),
    );
    expect(internal.hasMore).toBe(false);
  });

  it("omits categories the caller cannot read instead of reporting zero", async () => {
    const reader = await devLogin(h, "activity-reader", "reader");
    const readerResponse = await listChapters(h, { Cookie: reader });
    expect(readerResponse.status).toBe(200);
    expect(((await readerResponse.json()) as ChapterPage).items[0]?.activity).toEqual({
      openSuggestions: 2,
      openBlockComments: 2,
      openChapterComments: 1,
      openReplies: 4,
    });

    const chapterOnly = await mintToken(h, maintainer, ["chapters:read"], "chapter-only");
    const chapterOnlyResponse = await listChapters(h, {
      Authorization: `Bearer ${chapterOnly.token}`,
    });
    expect(chapterOnlyResponse.status).toBe(200);
    expect(((await chapterOnlyResponse.json()) as ChapterPage).items[0]?.activity).toEqual({});

    const workOnly = await mintToken(
      h,
      maintainer,
      ["chapters:read", "work:read"],
      "work-only",
    );
    const workOnlyResponse = await listChapters(h, {
      Authorization: `Bearer ${workOnly.token}`,
    });
    expect(workOnlyResponse.status).toBe(200);
    expect(((await workOnlyResponse.json()) as ChapterPage).items[0]?.activity).toEqual({
      openWorkItems: 5,
    });
  });

  it("returns unpublished summaries only to chapters:read without repository reads", async () => {
    const sourceRead = vi.spyOn(h.reader, "readTextFile");
    const token = await mintCanonicalToken(
      h,
      maintainer,
      ["chapters:read"],
      "outline-reader",
    );
    const authenticated = await listChapters(h, {
      Authorization: `Bearer ${token.token}`,
    });
    expect(authenticated.status).toBe(200);
    const body = (await authenticated.json()) as ChapterPage;
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: CHAPTER_2,
          status: "proposed",
          order: 20,
          summary: "A private proposed-chapter summary.",
        }),
      ]),
    );
    expect(sourceRead).not.toHaveBeenCalled();

    const anonymous = await listChapters(h, {});
    expect(anonymous.status).toBe(401);
  });

  it("uses one bounded collaboration query for a paginated chapter list", async () => {
    const originalPrepare = h.db.prepare.bind(h.db);
    let collaborationQueries = 0;
    let activitySql: string | null = null;
    h.db.prepare = (sql: string) => {
      if (
        sql.includes("annotation_activity") ||
        sql.includes("reply_activity") ||
        sql.includes("work_activity")
      ) {
        collaborationQueries += 1;
        activitySql = sql;
      }
      return originalPrepare(sql);
    };

    const response = await h.app.request(
      `/v1/projects/${h.projectId}/chapters?limit=1`,
      { headers: { Cookie: maintainer } },
    );
    expect(response.status).toBe(200);
    const firstPage = (await response.json()) as ChapterPage;
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBe(CHAPTER_ID);
    expect(collaborationQueries).toBe(1);

    const secondResponse = await h.app.request(
      `/v1/projects/${h.projectId}/chapters?limit=1&cursor=${CHAPTER_ID}`,
      { headers: { Cookie: maintainer } },
    );
    expect(secondResponse.status).toBe(200);
    const secondPage = (await secondResponse.json()) as ChapterPage;
    expect(secondPage.items.map((chapter) => chapter.id)).toEqual([CHAPTER_2]);
    expect(secondPage.nextCursor).toBeNull();
    expect(collaborationQueries).toBe(2);

    if (activitySql === null) throw new Error("chapter activity SQL was not captured");
    const planRows = await originalPrepare(`EXPLAIN QUERY PLAN ${activitySql}`)
      .bind(h.projectId, "", 2, ...ACTIVE_WORK_ITEM_STATUSES)
      .all<{ detail: string }>();
    const plan = planRows.map((row) => row.detail).join("\n");
    expect(plan).not.toMatch(/\bSCAN r\b/);
    expect(plan.match(/SEARCH r USING COVERING INDEX idx_replies_annotation_status/g)).toHaveLength(
      2,
    );
  });
});

async function listChapters(
  h: TestHarness,
  headers: Record<string, string>,
): Promise<Response> {
  return h.app.request(`/v1/projects/${h.projectId}/chapters`, { headers });
}

async function seedActivity(h: TestHarness): Promise<void> {
  const author = await h.repos.actors.getByExternalIdentity("github:activity-owner");
  if (author === null) throw new Error("activity test author was not created");
  const firstChapter = await h.repos.chapters.getById(CHAPTER_ID);
  if (firstChapter === null) throw new Error("fixture chapter was not projected");
  await h.repos.chapters.upsert({
    ...firstChapter,
    id: CHAPTER_2,
    path: "chapters/002-zero-activity.md",
    slug: "zero-activity",
    title: "Zero activity",
    summary: "A private proposed-chapter summary.",
    order: 20,
    status: "proposed",
  });

  const annotationIds: string[] = [];
  const insertAnnotation = async (
    kind: AnnotationRecord["kind"],
    scope: AnnotationRecord["scope"],
    status: AnnotationRecord["status"],
  ): Promise<string> => {
    const id = uuidv7();
    annotationIds.push(id);
    await h.repos.annotations.insert({
      id,
      projectId: h.projectId,
      chapterId: CHAPTER_ID,
      kind,
      scope,
      chapterRevision: 3,
      target: scope === "chapter" ? null : { blockId: uuidv7() },
      authorActorId: author.id,
      body: `${status} ${kind}`,
      status,
      gitOperationId: null,
      supersededBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  };

  const suggestion = await insertAnnotation("suggestion", "range", "open");
  await insertAnnotation("suggestion", "chapter", "open");
  const blockComment = await insertAnnotation("comment", "block", "open");
  await insertAnnotation("comment", "range", "open");
  const chapterComment = await insertAnnotation("comment", "chapter", "open");
  const promoted = await insertAnnotation("suggestion", "block", "work_item_created");

  for (const status of [
    "pending_git",
    "accepted",
    "resolved",
    "rejected",
    "withdrawn",
    "superseded",
    "orphaned",
    "needs_reanchor",
  ] as const) {
    await insertAnnotation("comment", "chapter", status);
  }

  const insertReply = async (
    annotationId: string,
    status: ReplyRecord["status"],
    parentReplyId: string | null = null,
  ): Promise<string> => {
    const id = uuidv7();
    await h.repos.replies.insert({
      id,
      projectId: h.projectId,
      annotationId,
      parentReplyId,
      authorActorId: author.id,
      body: `${status} reply`,
      status,
      gitOperationId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  };

  await insertReply(suggestion, "open");
  await insertReply(blockComment, "open");
  const parentReply = await insertReply(chapterComment, "open");
  await insertReply(chapterComment, "open", parentReply);
  await insertReply(suggestion, "pending_git");
  await insertReply(suggestion, "withdrawn");
  await insertReply(promoted, "open");
  for (const annotationId of annotationIds.slice(6)) {
    await insertReply(annotationId, "open");
  }

  for (const status of ALL_WORK_ITEM_STATUSES) {
    const workItem: WorkItemRecord = {
      id: uuidv7(),
      projectId: h.projectId,
      type: "revise_block",
      status,
      sourceAnnotationId: status === "ready" ? promoted : uuidv7(),
      chapterId: CHAPTER_ID,
      baseRevision: 3,
      target: { blockId: uuidv7() },
      priority: "normal",
      createdAt: NOW,
      updatedAt: NOW,
    };
    await h.repos.workItems.insert(workItem);
  }
}
