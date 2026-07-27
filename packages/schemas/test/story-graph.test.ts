import { describe, it } from "vitest";
import { storyGraphSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, validStoryGraph } from "./samples.js";

describe("storyGraphSchema", () => {
  it("accepts the design 8.5 example", () => {
    expectValid(storyGraphSchema, validStoryGraph);
  });

  it("accepts an empty graph without links", () => {
    expectValid(storyGraphSchema, {
      schema: "authorbot.story-graph/v1",
      nodes: [],
    });
  });

  it("accepts semantic node types", () => {
    const graph = clone(validStoryGraph);
    graph.nodes.push(
      { id: "character:mara", type: "character", title: "Mara", order: 50 },
      { id: "concept:causal-projector", type: "concept", order: 60 },
      { id: "rule:no-retcons", type: "rule", order: 70 },
      { id: "theme:observation", type: "theme", order: 80 },
      { id: "motif:the-window", type: "motif", order: 90 },
      { id: "development:going-public", type: "development", order: 100 },
    );
    expectValid(storyGraphSchema, graph);
  });

  it("rejects an unknown node type", () => {
    const bad = clone(validStoryGraph);
    bad.nodes[0].type = "epilogue";
    expectInvalid(storyGraphSchema, bad);
  });

  it("rejects a chapter node without chapter_id", () => {
    const bad = clone(validStoryGraph);
    delete bad.nodes[2].chapter_id;
    expectInvalid(storyGraphSchema, bad);
  });

  it("rejects a chapter node with a UUIDv4 chapter_id", () => {
    const bad = clone(validStoryGraph);
    bad.nodes[2].chapter_id = BAD_UUID_V4;
    expectInvalid(storyGraphSchema, bad);
  });

  it("rejects a non-chapter node carrying chapter_id", () => {
    const bad = clone(validStoryGraph);
    bad.nodes[3].chapter_id = bad.nodes[2].chapter_id;
    expectInvalid(storyGraphSchema, bad);
  });

  it("rejects a node id with an unknown kind", () => {
    const bad = clone(validStoryGraph);
    bad.nodes[0].id = "epilogue:main";
    expectInvalid(storyGraphSchema, bad);
  });

  it("rejects a node without order", () => {
    const bad = clone(validStoryGraph);
    delete bad.nodes[1].order;
    expectInvalid(storyGraphSchema, bad);
  });

  it("rejects an unknown node key", () => {
    const bad = clone(validStoryGraph);
    bad.nodes[0].mood = "ominous";
    expectInvalid(storyGraphSchema, bad);
  });

  it("rejects a link without an endpoint", () => {
    const bad = clone(validStoryGraph);
    delete bad.links[0].to;
    expectInvalid(storyGraphSchema, bad);
  });

  it("rejects a wrong schema discriminator", () => {
    const bad = clone(validStoryGraph);
    bad.schema = "authorbot.story-graph/v2";
    expectInvalid(storyGraphSchema, bad);
  });
});
