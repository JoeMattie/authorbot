import { describe, expect, it } from "vitest";
import { isUuidv7 } from "../src/index.js";

describe("isUuidv7", () => {
  it("accepts lowercase UUIDv7 values", () => {
    expect(isUuidv7("0190f27e-1a93-7b61-996a-9f94849d27a8")).toBe(true);
    expect(isUuidv7("0190f301-7045-7b2d-9d91-95b3c8228b54")).toBe(true);
  });

  it("rejects other identifiers", () => {
    expect(isUuidv7("0190F27E-1A93-7B61-996A-9F94849D27A8")).toBe(false); // uppercase
    expect(isUuidv7("0190f27e-1a93-4b61-996a-9f94849d27a8")).toBe(false); // v4
    expect(isUuidv7("0190f27e-1a93-7b61-c96a-9f94849d27a8")).toBe(false); // bad variant
    expect(isUuidv7("0190f27e1a937b61996a9f94849d27a8")).toBe(false); // no dashes
    expect(isUuidv7("chapter:opening")).toBe(false);
    expect(isUuidv7("")).toBe(false);
  });
});
