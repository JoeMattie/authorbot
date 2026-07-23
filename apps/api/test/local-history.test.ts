import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsBookRepoReader } from "../src/projection/local-fs.js";
import {
  cloneExampleBookRepo,
  git,
  type BookRepoClone,
} from "./integration/helpers.js";

const PROJECT_ID = "local-history-project";
const CHAPTER_PATH = "chapters/001-baseline.md";

describe("LocalFsBookRepoReader repository history", () => {
  let clone: BookRepoClone;
  let reader: LocalFsBookRepoReader;
  let baselineSource: string;
  let baselineSha: string;
  let firstSha: string;
  let latestSha: string;
  let latestSource: string;

  beforeEach(async () => {
    clone = await cloneExampleBookRepo();
    reader = new LocalFsBookRepoReader(clone.workTreePath);
    const chapter = join(clone.workTreePath, CHAPTER_PATH);
    baselineSource = await readFile(chapter, "utf8");
    baselineSha = (await git(clone.workTreePath, "rev-parse", "HEAD")).trim();

    const firstSource = `${baselineSource}\nFirst local history edit.\n`;
    await writeFile(chapter, firstSource, "utf8");
    await git(clone.workTreePath, "add", "--", CHAPTER_PATH);
    await git(
      clone.workTreePath,
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "First local history edit",
    );
    firstSha = (await git(clone.workTreePath, "rev-parse", "HEAD")).trim();

    latestSource = `${firstSource}\nSecond local history edit.\n`;
    await writeFile(chapter, latestSource, "utf8");
    await git(clone.workTreePath, "add", "--", CHAPTER_PATH);
    await git(
      clone.workTreePath,
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "Second local history edit",
    );
    latestSha = (await git(clone.workTreePath, "rev-parse", "HEAD")).trim();
  });

  afterEach(async () => {
    await clone.cleanup();
  });

  it("returns capped newest-first pages with exact continuation metadata", async () => {
    const first = await reader.listFileHistory(PROJECT_ID, CHAPTER_PATH, {
      page: 1,
      limit: 2,
    });
    expect(first).toEqual({
      outcome: "found",
      entries: [
        expect.objectContaining({
          commitSha: latestSha,
          message: "Second local history edit",
          authorName: "Fixture",
          authorLogin: null,
          parentShas: [firstSha],
        }),
        expect.objectContaining({
          commitSha: firstSha,
          message: "First local history edit",
          authorName: "Fixture",
          authorLogin: null,
          parentShas: [baselineSha],
        }),
      ],
      page: 1,
      hasMore: true,
    });

    const second = await reader.listFileHistory(PROJECT_ID, CHAPTER_PATH, {
      page: 2,
      limit: 2,
    });
    expect(second).toEqual({
      outcome: "found",
      entries: [
        expect.objectContaining({
          commitSha: baselineSha,
          message: "book repo baseline",
          parentShas: [],
        }),
      ],
      page: 2,
      hasMore: false,
    });
  });

  it("reads exact historical text and refuses unsafe paths or object ids", async () => {
    await expect(
      reader.readTextFileAtCommit(PROJECT_ID, CHAPTER_PATH, baselineSha),
    ).resolves.toEqual({ outcome: "found", source: baselineSource });
    await expect(
      reader.readTextFileAtCommit(PROJECT_ID, CHAPTER_PATH, latestSha),
    ).resolves.toEqual({ outcome: "found", source: latestSource });

    await expect(
      reader.readTextFileAtCommit(PROJECT_ID, "../book-secrets/creds.env", latestSha),
    ).resolves.toEqual({ outcome: "not-found" });
    await expect(
      reader.readTextFileAtCommit(PROJECT_ID, "/etc/passwd", latestSha),
    ).resolves.toEqual({ outcome: "not-found" });
    await expect(
      reader.readTextFileAtCommit(PROJECT_ID, CHAPTER_PATH, "not-a-commit"),
    ).resolves.toEqual({ outcome: "not-found" });

    await expect(
      reader.listFileHistory(PROJECT_ID, "../book-secrets/creds.env"),
    ).resolves.toEqual({
      outcome: "found",
      entries: [],
      page: 1,
      hasMore: false,
    });
  });

  it("lists only commits whose selected path can be read at that commit", async () => {
    const renamedPath = "chapters/001-renamed-baseline.md";
    await git(clone.workTreePath, "mv", "--", CHAPTER_PATH, renamedPath);
    await git(
      clone.workTreePath,
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "Rename the baseline chapter file",
    );
    const renameSha = (await git(clone.workTreePath, "rev-parse", "HEAD")).trim();

    const history = await reader.listFileHistory(PROJECT_ID, renamedPath);
    expect(history).toMatchObject({
      outcome: "found",
      entries: [{ commitSha: renameSha, message: "Rename the baseline chapter file" }],
      hasMore: false,
    });
    if (history.outcome !== "found") throw new Error("local history was unavailable");
    for (const entry of history.entries) {
      await expect(
        reader.readTextFileAtCommit(PROJECT_ID, renamedPath, entry.commitSha),
      ).resolves.toEqual({ outcome: "found", source: latestSource });
    }
  });
});
