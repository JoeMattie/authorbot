/** Canonical valid samples, one per artifact. UUIDs are lowercase UUIDv7. */

export const UUIDS = {
  book: "0190f27c-6e65-7ca5-a596-9f093d577aba",
  chapter: "0190f27d-8ea5-7e43-a6f2-64d6939ff3b4",
  block: "0190f27e-1a93-7b61-996a-9f94849d27a8",
  block2: "0190f27e-76db-79c2-a455-a16916f79126",
  annotation: "0190f300-2f7e-7467-b288-5e3c5a4bd991",
  workItem: "0190f301-7045-7b2d-9d91-95b3c8228b54",
  reply: "0190f302-1111-7abc-8def-000000000001",
  decision: "0190f303-2222-7abc-9def-000000000002",
  release: "0190f304-3333-7abc-adef-000000000003",
} as const;

/** Same as UUIDS.book but with version nibble 4. */
export const BAD_UUID_V4 = "0190f27c-6e65-4ca5-a596-9f093d577aba";

export const validBook = {
  schema: "authorbot.book/v1",
  id: UUIDS.book,
  title: "Example Serial",
  slug: "example-serial",
  language: "en-US",
  license: "CC-BY-NC-4.0",
  repository: { default_branch: "main" },
  content: { chapters_glob: "chapters/*.md", raw_html: false },
  planning: {
    method: "custom",
    outline: "story/outline.yml",
    timeline: "story/timeline.yml",
    characters_glob: "story/characters/*.md",
  },
  publication: {
    chapter_url: "/chapters/{slug}/",
    show_revision: true,
    show_attribution: true,
    show_public_annotations: true,
  },
};

export const validChapter = {
  schema: "authorbot.chapter/v1",
  id: UUIDS.chapter,
  slug: "opening",
  title: "Opening",
  order: 10,
  status: "published",
  revision: 4,
  published_at: "2026-07-19T18:00:00Z",
  authors: [{ actor: "github:octocat" }],
  summary: "A concise summary for navigation and agent context.",
  timeline_refs: ["event:first-contact"],
  character_refs: ["character:protagonist"],
};

export const validStoryGraph = {
  schema: "authorbot.story-graph/v1",
  nodes: [
    {
      id: "premise:main",
      type: "premise",
      title: "Core premise",
      summary: "One sentence.",
      order: 10,
    },
    { id: "part:one", type: "part", title: "Part One", parent: "premise:main", order: 20 },
    {
      id: "chapter:opening",
      type: "chapter",
      chapter_id: UUIDS.chapter,
      parent: "part:one",
      order: 30,
      status: "published",
    },
    {
      id: "scene:opening-lab",
      type: "scene",
      parent: "chapter:opening",
      order: 40,
      goal: "Establish the anomaly.",
      conflict: "The apparatus disagrees with itself.",
      outcome: "The team repeats the experiment.",
    },
  ],
  links: [
    { from: "scene:opening-lab", to: "concept:causal-projector", type: "introduces" },
  ],
};

export const validTimeline = {
  schema: "authorbot.timeline/v1",
  calendar: { type: "relative", epoch_label: "Project Day 0" },
  events: [
    {
      id: "event:first-contact",
      sort_key: 120800,
      display_time: "Project Day 12, 08:00",
      title: "First stable contact",
      participants: ["character:protagonist"],
      locations: ["location:main-lab"],
      chapter_refs: [UUIDS.chapter],
      facts: ["The chamber is under negative pressure."],
    },
  ],
};

export const validCharacter = {
  schema: "authorbot.character/v1",
  id: "character:protagonist",
  name: "The Protagonist",
  aliases: ["The Lead"],
  summary: "Keeps the experiment honest.",
  status: "active",
};

export const validRangeAnnotation = {
  schema: "authorbot.annotation/v1",
  id: UUIDS.annotation,
  kind: "suggestion",
  scope: "range",
  chapter_id: UUIDS.chapter,
  chapter_revision: 4,
  author: "github:octocat",
  status: "open",
  created_at: "2026-07-19T18:05:00Z",
  target: {
    blockId: UUIDS.block2,
    textPosition: { start: 118, end: 163 },
    textQuote: {
      // prefix/suffix are pinned at ≤ 32 characters (contract 2b §2.2).
      exact: "the text selected by the contributor",
      prefix: "up to 32 normalized chars before",
      suffix: " and up to 32 normalized after",
    },
  },
};

export const validBlockAnnotation = {
  schema: "authorbot.annotation/v1",
  id: UUIDS.annotation,
  kind: "comment",
  scope: "block",
  chapter_id: UUIDS.chapter,
  chapter_revision: 4,
  author: "agent:reviewer-1",
  status: "resolved",
  created_at: "2026-07-19T18:06:00Z",
  target: { blockId: UUIDS.block },
};

export const validChapterAnnotation = {
  schema: "authorbot.annotation/v1",
  id: UUIDS.annotation,
  kind: "comment",
  scope: "chapter",
  chapter_id: UUIDS.chapter,
  chapter_revision: 4,
  author: "github:octocat",
  status: "open",
  created_at: "2026-07-19T18:07:00Z",
};

export const validReply = {
  schema: "authorbot.reply/v1",
  id: UUIDS.reply,
  annotation_id: UUIDS.annotation,
  author: "github:octocat",
  created_at: "2026-07-19T18:10:00Z",
};

export const validDecision = {
  schema: "authorbot.decision/v1",
  id: UUIDS.decision,
  source_annotation_id: UUIDS.annotation,
  rule: "suggestion_to_work_item",
  rule_version: 1,
  metrics: { approvals: 3, net_score: 2, human_approvals: 1 },
  result: "create_work_item",
  work_item_id: UUIDS.workItem,
  effective_at: "2026-07-19T18:15:00Z",
};

export const validWorkItem = {
  schema: "authorbot.work-item/v1",
  id: UUIDS.workItem,
  type: "revise_range",
  status: "ready",
  source_annotation_id: UUIDS.annotation,
  chapter_id: UUIDS.chapter,
  base_revision: 4,
  priority: "normal",
  created_by: "system:rule-engine",
  created_at: "2026-07-19T18:20:00Z",
};

export const validAttribution = {
  schema: "authorbot.attribution/v1",
  chapter_id: UUIDS.chapter,
  entries: [
    {
      revision: 4,
      actor: "github:octocat",
      work_item_id: UUIDS.workItem,
      commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    },
  ],
};

export const validRelease = {
  schema: "authorbot.release/v1",
  id: UUIDS.release,
  created_at: "2026-07-19T19:00:00Z",
  chapters: [{ chapter_id: UUIDS.chapter, revision: 4 }],
  notes: "First public release.",
};

export const validInstance = {
  schema: "authorbot.instance/v1",
  project: { book_config_path: "book.yml", default_branch: "main" },
  access: {
    public_read: true,
    public_annotations: true,
    writes_require_membership: true,
  },
  annotations: {
    context_characters: 32,
    range_scope: "single_block",
    allow_range_comments: true,
    allow_chapter_comments: true,
  },
  votes: { values: ["approve", "reject", "abstain"], export: "aggregate" },
  rules: {
    suggestion_to_work_item: {
      version: 1,
      trigger: "vote_changed",
      when: {
        all: [
          { metric: "approvals", operator: "gte", value: 3 },
          { metric: "net_score", operator: "gte", value: 2 },
          { metric: "human_approvals", operator: "gte", value: 1 },
        ],
      },
      action: { type: "create_work_item", work_type: "revise_range" },
    },
  },
  leases: {
    duration: "PT30M",
    renewal_prompt_before: "PT5M",
    renewal_duration: "PT30M",
    maximum_total_duration: "PT4H",
  },
  publishing: { collaboration_data: "dynamic", static_snapshot_on_release: true },
};

export const validBuildManifest = {
  schema: "authorbot.build/v1",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  built_at: "2026-07-19T20:00:00Z",
  publisher_version: "0.1.0",
  base_url: "https://example.org/books/example-serial/",
  chapters: [
    {
      id: UUIDS.chapter,
      slug: "the-window",
      revision: 4,
      title: "The Window",
      status: "published",
    },
  ],
};
