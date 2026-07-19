import { describe, it } from "vitest";
import { timelineSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, validTimeline } from "./samples.js";

describe("timelineSchema", () => {
  it("accepts the design 8.6 example", () => {
    expectValid(timelineSchema, validTimeline);
  });

  it("accepts a timeline without a calendar", () => {
    const minimal = clone(validTimeline);
    delete minimal.calendar;
    expectValid(timelineSchema, minimal);
  });

  it("rejects an event without sort_key", () => {
    const bad = clone(validTimeline);
    delete bad.events[0].sort_key;
    expectInvalid(timelineSchema, bad);
  });

  it("rejects a non-numeric sort_key", () => {
    const bad = clone(validTimeline);
    bad.events[0].sort_key = "120800";
    expectInvalid(timelineSchema, bad);
  });

  it("rejects an event id of the wrong kind", () => {
    const bad = clone(validTimeline);
    bad.events[0].id = "scene:first-contact";
    expectInvalid(timelineSchema, bad);
  });

  it("rejects a participant that is not a character id", () => {
    const bad = clone(validTimeline);
    bad.events[0].participants = ["location:main-lab"];
    expectInvalid(timelineSchema, bad);
  });

  it("rejects a location that is not a location id", () => {
    const bad = clone(validTimeline);
    bad.events[0].locations = ["character:protagonist"];
    expectInvalid(timelineSchema, bad);
  });

  it("rejects a UUIDv4 chapter ref", () => {
    const bad = clone(validTimeline);
    bad.events[0].chapter_refs = [BAD_UUID_V4];
    expectInvalid(timelineSchema, bad);
  });

  it("rejects an unknown event key", () => {
    const bad = clone(validTimeline);
    bad.events[0].importance = "high";
    expectInvalid(timelineSchema, bad);
  });

  it("rejects an unknown calendar key", () => {
    const bad = clone(validTimeline);
    bad.calendar.timezone = "UTC";
    expectInvalid(timelineSchema, bad);
  });

  it("rejects a missing title", () => {
    const bad = clone(validTimeline);
    delete bad.events[0].title;
    expectInvalid(timelineSchema, bad);
  });
});
