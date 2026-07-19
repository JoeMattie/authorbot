import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_IDS, artifactSchemas, buildJsonSchemas } from "../src/index.js";

describe("buildJsonSchemas", () => {
  const documents = buildJsonSchemas();

  it("covers every artifact schema", () => {
    expect(Object.keys(documents).sort()).toEqual(
      Object.keys(artifactSchemas).sort(),
    );
    expect(Object.keys(documents)).toHaveLength(12);
  });

  it("stamps each document with its schema discriminator as $id", () => {
    for (const [name, document] of Object.entries(documents)) {
      expect(document["$id"]).toBe(SCHEMA_IDS[name as keyof typeof SCHEMA_IDS]);
    }
  });

  it("targets JSON Schema draft 2020-12", () => {
    for (const document of Object.values(documents)) {
      expect(document["$schema"]).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });

  it("keeps strictness in the generated output", () => {
    const book = documents.book as { additionalProperties?: unknown };
    expect(book.additionalProperties).toBe(false);
  });

  it("matches the checked-in json/*.schema.json files", () => {
    for (const [name, document] of Object.entries(documents)) {
      const filePath = new URL(`../json/${name}.schema.json`, import.meta.url);
      const onDisk: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      expect(onDisk, `${name}.schema.json is stale; run the build`).toEqual(
        document,
      );
    }
  });
});
