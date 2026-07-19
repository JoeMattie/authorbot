import { describe, it } from "vitest";
import { characterSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { validCharacter } from "./samples.js";

describe("characterSchema", () => {
  it("accepts a full character record", () => {
    expectValid(characterSchema, validCharacter);
  });

  it("accepts a minimal character record", () => {
    expectValid(characterSchema, {
      schema: "authorbot.character/v1",
      id: "character:protagonist",
      name: "The Protagonist",
    });
  });

  it("rejects an id of the wrong kind", () => {
    const bad = clone(validCharacter);
    bad.id = "event:protagonist";
    expectInvalid(characterSchema, bad);
  });

  it("rejects a missing name", () => {
    const bad = clone(validCharacter);
    delete bad.name;
    expectInvalid(characterSchema, bad);
  });

  it("rejects an empty alias", () => {
    const bad = clone(validCharacter);
    bad.aliases = [""];
    expectInvalid(characterSchema, bad);
  });

  it("rejects an unknown key", () => {
    const bad = clone(validCharacter);
    bad.age = 34;
    expectInvalid(characterSchema, bad);
  });

  it("rejects a wrong schema discriminator", () => {
    const bad = clone(validCharacter);
    bad.schema = "authorbot.character/v0";
    expectInvalid(characterSchema, bad);
  });
});
