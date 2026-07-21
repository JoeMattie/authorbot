/**
 * Phase 6 contract §3.6: book settings and in-book governance.
 *
 * These cover the API surface against the fake reader (fast, no git). The
 * genuine round trip - PATCH, drain, a real commit, `book.yml` still valid on
 * disk - lives in `test/integration/settings.test.ts`, because "settings
 * changes are commits" is only actually proved by a commit.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  FakeReader,
  createOpenSuggestion,
  devLogin,
  fixtureSnapshot,
  jsonRequest,
  makeHarness,
  type TestHarness,
} from "./helpers.js";
import { uuidv7 } from "../src/ids.js";

const BOOK_ID = "01900000-0000-7000-8000-0000000000bb";

/** A minimal valid `authorbot.book/v1` document for the fake repository. */
function bookConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "authorbot.book/v1",
    id: BOOK_ID,
    title: "Hollow Creek Anomaly",
    slug: "hollow-creek-anomaly",
    language: "en",
    license: "CC-BY-NC-4.0",
    content: { chapters_glob: "chapters/*.md", raw_html: false },
    publication: { chapter_url: "/chapters/{slug}/", show_revision: true },
    ...overrides,
  };
}

/** A harness whose fake repository contains `book.yml`. */
async function harnessWithBook(
  config: Record<string, unknown> = bookConfig(),
): Promise<TestHarness> {
  const reader = new FakeReader(fixtureSnapshot());
  reader.files.set("book.yml", stringify(config));
  return makeHarness({ reader });
}

const settingsPath = (h: TestHarness): string => `/v1/projects/${h.projectId}/settings`;

async function patch(h: TestHarness, cookie: string, body: unknown): Promise<Response> {
  return await h.app.request(settingsPath(h), jsonRequest("PATCH", body, { Cookie: cookie }));
}

describe("GET /v1/projects/:id/settings", () => {
  let h: TestHarness;
  let maintainer: string;
  beforeEach(async () => {
    h = await harnessWithBook();
    maintainer = await devLogin(h, "maeve", "maintainer");
  });
  afterEach(() => h.close());

  it("returns the editable settings, the guarded fields, and the read-only ones", async () => {
    const res = await h.app.request(settingsPath(h), { headers: { Cookie: maintainer } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { title: string; license: string; publication: Record<string, unknown> };
      guarded: Record<string, { value: unknown; consequence: string }>;
      readOnly: Record<string, unknown>;
      status: string;
    };
    expect(body.settings.title).toBe("Hollow Creek Anomaly");
    expect(body.settings.license).toBe("CC-BY-NC-4.0");
    expect(body.settings.publication["show_revision"]).toBe(true);
    expect(body.guarded["slug"]?.value).toBe("hollow-creek-anomaly");
    // The consequence travels with the value so the UI need not restate it.
    expect(body.guarded["slug"]?.consequence).toMatch(/breaks every existing link/i);
    expect(body.readOnly["id"]).toBe(BOOK_ID);
    expect(body.status).toBe("committed");
  });

  it("never-editable fields are absent from `settings` (exit criterion 10)", async () => {
    const res = await h.app.request(settingsPath(h), { headers: { Cookie: maintainer } });
    const body = (await res.json()) as { settings: Record<string, unknown> };
    // `settings` is what a form binds to; these must not appear in it.
    for (const key of ["id", "schema", "content", "repository"]) {
      expect(body.settings[key]).toBeUndefined();
    }
    expect((body.settings["publication"] as Record<string, unknown>)["api_url"]).toBeUndefined();
  });

  it("reports governance as `bootstrap` until the book declares its own rules", async () => {
    const res = await h.app.request(settingsPath(h), { headers: { Cookie: maintainer } });
    const body = (await res.json()) as {
      governance: {
        source: string;
        rules: Record<string, { version: number; when: { all: unknown[] } }>;
        vocabulary: { metrics: string[]; operators: string[] };
      };
    };
    expect(body.governance.source).toBe("bootstrap");
    const rule = body.governance.rules["suggestion_to_work_item"];
    expect(rule?.version).toBe(2);
    expect(rule?.when.all).toHaveLength(4);
    // The closed vocabulary is published so a UI can offer only valid metrics.
    expect(body.governance.vocabulary.metrics).toContain("human_maintainer_approvals");
    expect(body.governance.vocabulary.operators).toContain("gte");
  });

  it("is maintainer-only: a contributor is 403 and an anonymous reader is 401", async () => {
    const contributor = await devLogin(h, "cass", "contributor");
    expect((await h.app.request(settingsPath(h), { headers: { Cookie: contributor } })).status).toBe(
      403,
    );
    expect((await h.app.request(settingsPath(h))).status).toBe(401);
  });

  it("409s when the book config has never been projected from the repository", async () => {
    const bare = await makeHarness();
    try {
      const cookie = await devLogin(bare, "maeve", "maintainer");
      const res = await bare.app.request(`/v1/projects/${bare.projectId}/settings`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { detail: string };
      // The message must name the cause, not just refuse.
      expect(body.detail).toMatch(/has not been projected/i);
    } finally {
      bare.close();
    }
  });
});

describe("PATCH /v1/projects/:id/settings - editable fields", () => {
  let h: TestHarness;
  let maintainer: string;
  beforeEach(async () => {
    h = await harnessWithBook();
    maintainer = await devLogin(h, "maeve", "maintainer");
  });
  afterEach(() => h.close());

  it("queues a commit, marks the config pending, and reports what changed", async () => {
    const res = await patch(h, maintainer, { title: "The Hollow Creek Anomaly" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      operationId: string;
      status: string;
      changed: string[];
      settings: { title: string };
    };
    expect(body.status).toBe("queued");
    expect(body.changed).toEqual(["title"]);
    expect(body.settings.title).toBe("The Hollow Creek Anomaly");

    // The projection is updated immediately - the change is live now, not
    // whenever the outbox happens to drain.
    const row = await h.repos.bookConfigs.get(h.projectId);
    expect(row?.status).toBe("pending_git");
    expect((row?.config as { title: string }).title).toBe("The Hollow Creek Anomaly");
    expect(row?.gitOperationId).toBe(body.operationId);

    // A commit is queued through the ordinary outbox, not a side channel.
    const outbox = await h.repos.outbox.listPending(h.projectId, 10);
    expect(outbox.map((r) => r.kind)).toContain("book_config.update");
  });

  it("changes several fields at once and clears an optional with null", async () => {
    const res = await patch(h, maintainer, {
      language: "en-GB",
      license: null,
      publication: { show_attribution: true, show_revision: null },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { changed: string[] };
    expect(body.changed.sort()).toEqual(
      ["language", "license", "publication.show_attribution", "publication.show_revision"].sort(),
    );
    const row = await h.repos.bookConfigs.get(h.projectId);
    const config = row?.config as { license?: string; publication: Record<string, unknown> };
    // `null` removes the key entirely rather than writing `license: null`.
    expect(config.license).toBeUndefined();
    expect(config.publication["show_revision"]).toBeUndefined();
    expect(config.publication["show_attribution"]).toBe(true);
  });

  it("a patch that changes nothing returns 200 and queues no commit", async () => {
    const res = await patch(h, maintainer, { title: "Hollow Creek Anomaly" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({
      status: "unchanged",
      changed: [],
    });
    const outbox = await h.repos.outbox.listPending(h.projectId, 10);
    expect(outbox.filter((r) => r.kind === "book_config.update")).toHaveLength(0);
  });

  it("refuses a second change while the first is still in flight", async () => {
    expect((await patch(h, maintainer, { title: "First" })).status).toBe(202);
    const second = await patch(h, maintainer, { title: "Second" });
    expect(second.status).toBe(409);
    expect((await second.json()) as { detail: string }).toMatchObject({
      detail: expect.stringMatching(/has not been committed yet/i) as unknown as string,
    });
  });

  it("is maintainer-only", async () => {
    const contributor = await devLogin(h, "cass", "contributor");
    expect((await patch(h, contributor, { title: "Nope" })).status).toBe(403);
  });

  it("audits the change with the fields that moved", async () => {
    await patch(h, maintainer, { title: "Audited" });
    const events = await h.repos.auditEvents.listByProject(h.projectId, { limit: 100 });
    const event = events.find((e) => e.action === "book_config.update");
    expect(event).toBeDefined();
    expect((event?.metadata as { changed: string[] }).changed).toEqual(["title"]);
  });
});

describe("PATCH - never-editable fields (contract §3.6)", () => {
  let h: TestHarness;
  let maintainer: string;
  beforeEach(async () => {
    h = await harnessWithBook();
    maintainer = await devLogin(h, "maeve", "maintainer");
  });
  afterEach(() => h.close());

  for (const [label, body] of [
    ["id", { id: "01900000-0000-7000-8000-0000000000ff" }],
    ["repository.default_branch", { repository: { default_branch: "trunk" } }],
    ["content.chapters_glob", { content: { chapters_glob: "text/*.md" } }],
    ["content.raw_html", { content: { raw_html: true } }],
    ["publication.api_url", { publication: { api_url: "/elsewhere" } }],
    ["schema", { schema: "authorbot.book/v2" }],
  ] as const) {
    it(`rejects ${label} with a reason, not a bare refusal`, async () => {
      const res = await patch(h, maintainer, body);
      expect(res.status).toBe(422);
      const problem = (await res.json()) as {
        code: string;
        fields: { field: string; reason: string }[];
      };
      expect(problem.code).toBe("settings-field-immutable");
      expect(problem.fields.map((f) => f.field)).toContain(label);
      expect(problem.fields[0]?.reason.length).toBeGreaterThan(20);
    });
  }

  it("explains raw_html as a security decision belonging in a reviewed commit", async () => {
    const res = await patch(h, maintainer, { content: { raw_html: true } });
    const problem = (await res.json()) as { fields: { field: string; reason: string }[] };
    const reason = problem.fields.find((f) => f.field === "content.raw_html")?.reason ?? "";
    expect(reason).toMatch(/security decision/i);
    expect(reason).toMatch(/reviewed commit/i);
  });

  it("rejects an immutable field even when the value is unchanged", async () => {
    // raw_html is already false. Accepting this would teach a client that the
    // field is writable and merely happened to be a no-op.
    const res = await patch(h, maintainer, { content: { raw_html: false } });
    expect(res.status).toBe(422);
  });

  it("queues nothing when an immutable field is rejected", async () => {
    await patch(h, maintainer, { title: "Fine", content: { raw_html: true } });
    expect(await h.repos.outbox.listPending(h.projectId, 10)).toHaveLength(0);
    const row = await h.repos.bookConfigs.get(h.projectId);
    expect((row?.config as { title: string }).title).toBe("Hollow Creek Anomaly");
  });
});

describe("PATCH - guarded fields need confirmation (contract §3.6)", () => {
  let h: TestHarness;
  let maintainer: string;
  beforeEach(async () => {
    h = await harnessWithBook();
    maintainer = await devLogin(h, "maeve", "maintainer");
  });
  afterEach(() => h.close());

  it("refuses a slug change without confirmation and states what breaks", async () => {
    const res = await patch(h, maintainer, { slug: "hollow-creek" });
    expect(res.status).toBe(409);
    const problem = (await res.json()) as {
      code: string;
      fields: { field: string; breaks: string }[];
      confirmWith: string[];
    };
    expect(problem.code).toBe("settings-confirmation-required");
    expect(problem.fields[0]?.field).toBe("slug");
    expect(problem.fields[0]?.breaks).toMatch(/existing link/i);
    // The response tells the client exactly what to send back.
    expect(problem.confirmWith).toEqual(["slug"]);
    expect(await h.repos.outbox.listPending(h.projectId, 10)).toHaveLength(0);
  });

  it("refuses a chapter_url change without confirmation", async () => {
    const res = await patch(h, maintainer, { publication: { chapter_url: "/c/{slug}/" } });
    expect(res.status).toBe(409);
    const problem = (await res.json()) as { confirmWith: string[] };
    expect(problem.confirmWith).toEqual(["publication.chapter_url"]);
  });

  it("accepts the change once confirmed", async () => {
    const res = await patch(h, maintainer, { slug: "hollow-creek", confirm: ["slug"] });
    expect(res.status).toBe(202);
    expect((await res.json()) as { changed: string[] }).toMatchObject({ changed: ["slug"] });
  });

  it("confirming one guarded field does not confirm the other", async () => {
    const res = await patch(h, maintainer, {
      slug: "hollow-creek",
      publication: { chapter_url: "/c/{slug}/" },
      confirm: ["slug"],
    });
    expect(res.status).toBe(409);
    const problem = (await res.json()) as { confirmWith: string[] };
    expect(problem.confirmWith).toEqual(["publication.chapter_url"]);
  });

  it("does not demand confirmation for a guarded field set to its current value", async () => {
    // Nothing breaks, because nothing changed.
    const res = await patch(h, maintainer, {
      slug: "hollow-creek-anomaly",
      title: "Renamed",
    });
    expect(res.status).toBe(202);
    expect((await res.json()) as { changed: string[] }).toMatchObject({ changed: ["title"] });
  });

  it("an unconfirmed guarded change blocks the whole patch, including the safe parts", async () => {
    await patch(h, maintainer, { title: "Renamed", slug: "hollow-creek" });
    const row = await h.repos.bookConfigs.get(h.projectId);
    // All-or-nothing: a settings change is one commit.
    expect((row?.config as { title: string }).title).toBe("Hollow Creek Anomaly");
  });
});

describe("PATCH - governance rules (contract §3.6 amendment to Phase 3 §3)", () => {
  let h: TestHarness;
  let maintainer: string;
  beforeEach(async () => {
    h = await harnessWithBook();
    maintainer = await devLogin(h, "maeve", "maintainer");
  });
  afterEach(() => h.close());

  const rule = (conditions: { metric: string; operator: string; value: number }[]) => ({
    governance: {
      rules: {
        suggestion_to_work_item: {
          when: { all: conditions },
          action: { type: "create_work_item", work_type: "revise_range" },
        },
      },
    },
  });

  it("adopts the rule into book.yml and bumps the version past the bootstrap default", async () => {
    const res = await patch(
      h,
      maintainer,
      rule([{ metric: "approvals", operator: "gte", value: 2 }]),
    );
    expect(res.status).toBe(202);
    const row = await h.repos.bookConfigs.get(h.projectId);
    const stored = (row?.config as { governance: { rules: Record<string, { version: number }> } })
      .governance.rules["suggestion_to_work_item"];
    // The bootstrap default is version 2; adopting a DIFFERENT rule under the
    // same name must not reuse that version, or a decision could no longer be
    // read back to the rule that produced it.
    expect(stored?.version).toBe(3);
  });

  it("re-saving the same rule does not churn the version", async () => {
    const patchBody = rule([{ metric: "approvals", operator: "gte", value: 2 }]);
    await patch(h, maintainer, patchBody);
    // Let the first change settle so the second is not blocked as in-flight.
    await markCommitted(h);
    const second = await patch(h, maintainer, patchBody);
    expect(second.status).toBe(200);
    expect((await second.json()) as { status: string }).toMatchObject({ status: "unchanged" });
    const row = await h.repos.bookConfigs.get(h.projectId);
    const stored = (row?.config as { governance: { rules: Record<string, { version: number }> } })
      .governance.rules["suggestion_to_work_item"];
    expect(stored?.version).toBe(3);
  });

  it("a further edit bumps the version again", async () => {
    await patch(h, maintainer, rule([{ metric: "approvals", operator: "gte", value: 2 }]));
    await markCommitted(h);
    await patch(h, maintainer, rule([{ metric: "approvals", operator: "gte", value: 5 }]));
    const row = await h.repos.bookConfigs.get(h.projectId);
    const stored = (row?.config as { governance: { rules: Record<string, { version: number }> } })
      .governance.rules["suggestion_to_work_item"];
    expect(stored?.version).toBe(4);
  });

  /**
   * Regression (§3.6 / Phase 3 §4). `governance.rules` replaces the map
   * wholesale and versions were derived only from the currently EFFECTIVE
   * rules, so deleting a rule dropped it out of that set and re-adding the
   * name later restarted it at version 1.
   *
   * Decisions are keyed `(source_annotation_id, action_type, rule_version)`
   * with no rule name, so the re-added rule's first evaluation matched a
   * decision row produced by materially different semantics - the exact
   * ambiguity `DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE` is pinned at version 2 to
   * avoid, now re-created against real decision rows.
   */
  it("never reuses a version a decision already recorded for that rule name", async () => {
    // The rule reaches version 3, and a decision is recorded against it.
    await patch(h, maintainer, rule([{ metric: "approvals", operator: "gte", value: 2 }]));
    await markCommitted(h);
    await h.repos.decisions.insert({
      id: uuidv7(),
      projectId: h.projectId,
      sourceAnnotationId: uuidv7(),
      actionType: "create_work_item",
      rule: "suggestion_to_work_item",
      ruleVersion: 3,
      metrics: {},
      result: "create_work_item",
      supportChanged: false,
      overrideReason: null,
      workItemId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    // The maintainer removes it - legal, since another rule remains.
    const removed = await patch(h, maintainer, {
      governance: {
        rules: {
          other_rule: {
            when: { all: [{ metric: "approvals", operator: "gte", value: 9 }] },
            action: { type: "create_work_item", work_type: "revise_range" },
          },
        },
      },
    });
    expect(removed.status).toBe(202);
    await markCommitted(h);

    // …and later re-adds the name with different semantics.
    const readded = await patch(
      h,
      maintainer,
      rule([{ metric: "approvals", operator: "gte", value: 4 }]),
    );
    expect(readded.status).toBe(202);

    const row = await h.repos.bookConfigs.get(h.projectId);
    const stored = (row?.config as { governance: { rules: Record<string, { version: number }> } })
      .governance.rules["suggestion_to_work_item"];
    // Above the burned version 3, not back to 1.
    expect(stored?.version).toBeGreaterThan(3);
  });

  it("rejects a client-supplied version rather than silently ignoring it", async () => {
    const res = await patch(h, maintainer, {
      governance: {
        rules: {
          suggestion_to_work_item: {
            version: 99,
            when: { all: [{ metric: "approvals", operator: "gte", value: 2 }] },
            action: { type: "create_work_item", work_type: "revise_range" },
          },
        },
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "validation-failed" });
  });

  it("rejects a rule naming a metric outside the closed vocabulary", async () => {
    const res = await patch(
      h,
      maintainer,
      rule([{ metric: "vibes", operator: "gte", value: 1 }]),
    );
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { issues: { path: string; message: string }[] };
    // Caught at write time: a rule referencing an unknown metric fails closed
    // at evaluation, which would leave a maintainer unable to promote anything
    // and with nothing to read explaining why.
    expect(problem.issues[0]?.message).toMatch(/unknown metric "vibes"/);
    expect(problem.issues[0]?.message).toMatch(/human_maintainer_approvals/);
  });

  it("rejects an operator the engine does not evaluate", async () => {
    const res = await patch(
      h,
      maintainer,
      rule([{ metric: "approvals", operator: "neq", value: 1 }]),
    );
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { issues: { message: string }[] };
    expect(problem.issues.some((i) => /not evaluated/.test(i.message))).toBe(true);
  });

  it("a rule edit takes effect on the NEXT vote, not the next deploy", async () => {
    // Lower the bar to a single approval, with no maintainer clause at all.
    const res = await patch(
      h,
      maintainer,
      rule([{ metric: "approvals", operator: "gte", value: 1 }]),
    );
    expect(res.status).toBe(202);

    const author = await devLogin(h, "avery", "contributor");
    const annotationId = await createOpenSuggestion(h, author);
    const vote = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${annotationId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: author }),
    );
    expect(vote.status).toBe(200);
    const body = (await vote.json()) as {
      ruleSatisfied: boolean;
      decision: { result: string } | null;
    };
    // One contributor approval - impossible under the default rule, correct
    // under the rule the maintainer just saved.
    expect(body.ruleSatisfied).toBe(true);
    expect(body.decision?.result).toBe("create_work_item");

    const decisions = await h.repos.decisions.listByAnnotation(annotationId);
    expect(decisions).toHaveLength(1);
    // The decision records the version the edit assigned, so it can be read
    // back to the rule that produced it.
    expect(decisions[0]?.ruleVersion).toBe(3);
  });

  it("removing the human-maintainer clause is allowed - the veto is the author's to drop", async () => {
    await patch(
      h,
      maintainer,
      rule([
        { metric: "approvals", operator: "gte", value: 3 },
        { metric: "net_score", operator: "gte", value: 2 },
      ]),
    );
    const row = await h.repos.bookConfigs.get(h.projectId);
    const stored = (
      row?.config as {
        governance: { rules: Record<string, { when: { all: { metric: string }[] } }> };
      }
    ).governance.rules["suggestion_to_work_item"];
    expect(stored?.when.all.map((c) => c.metric)).toEqual(["approvals", "net_score"]);
  });

  it("a book with no governance section keeps running on the bootstrap default", async () => {
    // Backwards compatibility: books created before Phase 6 are unaffected.
    const bare = await harnessWithBook(bookConfig());
    try {
      const cookie = await devLogin(bare, "maeve", "maintainer");
      const res = await bare.app.request(`/v1/projects/${bare.projectId}/settings`, {
        headers: { Cookie: cookie },
      });
      const body = (await res.json()) as { governance: { source: string } };
      expect(body.governance.source).toBe("bootstrap");
    } finally {
      bare.close();
    }
  });
});

describe("the default rule requires the author's approval (contract §3.6)", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await harnessWithBook();
  });
  afterEach(() => h.close());

  const approve = async (cookie: string, annotationId: string): Promise<Response> =>
    await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${annotationId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: cookie }),
    );

  it("three contributor approvals cross the numbers but do NOT become work", async () => {
    const author = await devLogin(h, "avery", "contributor");
    const id = await createOpenSuggestion(h, author);
    for (const login of ["avery", "bella", "cyril"]) {
      const cookie = await devLogin(h, login, "contributor");
      await approve(cookie, id);
    }
    const tally = await h.repos.votes.tally(id);
    // The numeric thresholds are all met...
    expect(tally.approvals).toBe(3);
    expect(tally.netScore).toBe(3);
    expect(tally.humanApprovals).toBe(3);
    // ...but no human maintainer approved.
    expect(tally.humanMaintainerApprovals).toBe(0);
    expect(await h.repos.decisions.listByAnnotation(id)).toHaveLength(0);
    expect(await h.repos.workItems.listBySourceAnnotation(id)).toHaveLength(0);
    expect((await h.repos.annotations.getById(id))?.status).toBe("open");
  });

  it("the author's approval turns the same tally into work", async () => {
    const author = await devLogin(h, "avery", "contributor");
    const id = await createOpenSuggestion(h, author);
    await approve(await devLogin(h, "bella", "contributor"), id);
    await approve(await devLogin(h, "cyril", "contributor"), id);
    const crossing = await approve(await devLogin(h, "maeve", "maintainer"), id);
    const body = (await crossing.json()) as { ruleSatisfied: boolean };
    expect(body.ruleSatisfied).toBe(true);
    expect(await h.repos.workItems.listBySourceAnnotation(id)).toHaveLength(1);
  });
});

/**
 * Mark the pending config committed without running a real drain - these are
 * fake-reader tests and the point here is the *next* PATCH, not the commit.
 * The genuine transition is exercised in the integration suite.
 */
async function markCommitted(h: TestHarness): Promise<void> {
  const row = await h.repos.bookConfigs.get(h.projectId);
  if (row === null) return;
  await h.repos.bookConfigs.upsert({ ...row, status: "committed", gitOperationId: null });
}

/**
 * `apps/api/src/book-config.ts` declares its own `BOOK_CONFIG_PATH` rather than
 * importing the repo-coordinator's, because that package's barrel pulls in
 * `node:child_process` and this module is reached from Worker-safe code. Two
 * declarations of one fact need a test holding them together.
 */
describe("BOOK_CONFIG_PATH is declared twice and must not drift", () => {
  it("the API's copy equals the repo-coordinator's", async () => {
    const api = await import("../src/book-config.js");
    const coordinator = await import("@authorbot/repo-coordinator");
    expect(api.BOOK_CONFIG_PATH).toBe(coordinator.BOOK_CONFIG_PATH);
    expect(api.BOOK_CONFIG_PATH).toBe("book.yml");
  });
});

/**
 * A settings PATCH produces a commit, so replaying it must not produce a
 * second one. This is the same guarantee every other mutating route has; it is
 * pinned here because "settings changes are commits" makes a duplicate
 * expensive rather than merely untidy.
 */
describe("PATCH is idempotent (Phase 2 contract §4)", () => {
  let h: TestHarness;
  let maintainer: string;
  beforeEach(async () => {
    h = await harnessWithBook();
    maintainer = await devLogin(h, "maeve", "maintainer");
  });
  afterEach(() => h.close());

  it("requires an Idempotency-Key", async () => {
    const res = await h.app.request(settingsPath(h), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        Cookie: maintainer,
      },
      body: JSON.stringify({ title: "No key" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "idempotency-key-required",
    });
  });

  it("replaying the same key replays the response and queues no second commit", async () => {
    const key = "01900000-0000-7000-8000-00000000ffff";
    const send = async (): Promise<Response> =>
      await h.app.request(settingsPath(h), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          Cookie: maintainer,
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ title: "Replayed" }),
      });

    const first = await send();
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { operationId: string };

    const replay = await send();
    expect(replay.status).toBe(202);
    expect((await replay.json()) as { operationId: string }).toMatchObject({
      operationId: firstBody.operationId,
    });

    const outbox = await h.repos.outbox.listPending(h.projectId, 20);
    expect(outbox.filter((r) => r.kind === "book_config.update")).toHaveLength(1);
  });
});
