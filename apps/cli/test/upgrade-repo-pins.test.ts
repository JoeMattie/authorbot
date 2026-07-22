import { describe, expect, it } from "vitest";
import {
  rewriteAuthorbotPins,
  rewritePin,
  UpgradeRepoError,
} from "../src/upgrade/repo.js";

describe("rewriteAuthorbotPins", () => {
  it("aligns CLI and API pins when both live in devDependencies", () => {
    const before = `{
  "name": "book-with-api",
  "devDependencies": {
    "@authorbot/api": "0.1.7",
    "@authorbot/cli": "^0.1.22"
  }
}
`;

    expect(rewriteAuthorbotPins(before, "0.1.31")).toBe(`{
  "name": "book-with-api",
  "devDependencies": {
    "@authorbot/api": "0.1.31",
    "@authorbot/cli": "0.1.31"
  }
}
`);
  });

  it("aligns pins split between dependencies and devDependencies", () => {
    const before = `{
  "dependencies": {
    "@authorbot/api": "~0.1.19"
  },
  "devDependencies": {
    "@authorbot/cli": "0.1.22"
  }
}`;

    const after = rewriteAuthorbotPins(before, "0.1.31");
    expect(JSON.parse(after)).toMatchObject({
      dependencies: { "@authorbot/api": "0.1.31" },
      devDependencies: { "@authorbot/cli": "0.1.31" },
    });
  });

  it("updates Authorbot packages when both are regular dependencies", () => {
    const before = `{
  "dependencies": {
    "@authorbot/cli": "0.1.22",
    "@authorbot/api": "0.1.9"
  }
}`;

    expect(rewriteAuthorbotPins(before, "0.1.31")).toContain(
      '"@authorbot/cli": "0.1.31",\n    "@authorbot/api": "0.1.31"',
    );
  });

  it("does not add the API package to a static book", () => {
    const before = `{
  "devDependencies": {
    "@authorbot/cli": "0.1.22",
    "typescript": "5.9.2"
  }
}
`;

    const after = rewriteAuthorbotPins(before, "0.1.31");
    expect(after).toBe(
      before.replace('"@authorbot/cli": "0.1.22"', '"@authorbot/cli": "0.1.31"'),
    );
    expect(after).not.toContain("@authorbot/api");
  });

  it("preserves formatting and ignores non-direct package references", () => {
    const before =
      '{\n' +
      '\t"scripts" : { "show-pin": "echo @authorbot/api@0.1.4" },\n' +
      '\t"overrides": { "@authorbot/api": "0.1.5" },\n' +
      '\t"dependencies" : {\n' +
      '\t\t"left-pad":"1.3.0",\n' +
      '\t\t"@authorbot/api"   :   "0.1.6"\n' +
      '\t},\n' +
      '\t"devDependencies" : { "@authorbot/cli":"~0.1.22" }\n' +
      '}\n';
    const expected = before
      .replace('"@authorbot/api"   :   "0.1.6"', '"@authorbot/api"   :   "0.1.31"')
      .replace('"@authorbot/cli":"~0.1.22"', '"@authorbot/cli":"0.1.31"');

    const after = rewriteAuthorbotPins(before, "0.1.31");
    expect(after).toBe(expected);
    expect(after).toContain('"overrides": { "@authorbot/api": "0.1.5" }');
  });

  it("corrects an API pin that was already mismatched from the CLI", () => {
    const before = `{
  "dependencies": { "@authorbot/api": "0.0.14" },
  "devDependencies": { "@authorbot/cli": "0.1.30" }
}`;

    expect(rewriteAuthorbotPins(before, "0.1.31")).toBe(`{
  "dependencies": { "@authorbot/api": "0.1.31" },
  "devDependencies": { "@authorbot/cli": "0.1.31" }
}`);
  });

  it("still requires a direct CLI dependency", () => {
    const before = `{
  "dependencies": { "@authorbot/api": "0.1.22" }
}`;

    expect(() => rewriteAuthorbotPins(before, "0.1.31")).toThrowError(UpgradeRepoError);
    expect(() => rewriteAuthorbotPins(before, "0.1.31")).toThrow(
      "could not locate the @authorbot/cli dependency",
    );
  });
});

describe("rewritePin compatibility", () => {
  it("continues to rewrite only the CLI spec supplied by the caller", () => {
    const before = `{
  "dependencies": {
    "@authorbot/api": "0.1.9",
    "@authorbot/cli": "0.1.22"
  }
}`;

    expect(rewritePin(before, "^0.1.31")).toBe(`{
  "dependencies": {
    "@authorbot/api": "0.1.9",
    "@authorbot/cli": "^0.1.31"
  }
}`);
  });
});
