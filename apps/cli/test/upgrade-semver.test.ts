import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isPrerelease,
  maxVersion,
  mustParseVersion,
  parsePin,
  parseVersion,
  renderPin,
} from "../src/upgrade/semver.js";

describe("version parsing", () => {
  it("accepts releases with and without a leading v", () => {
    expect(parseVersion("1.2.3")?.raw).toBe("1.2.3");
    expect(parseVersion("v1.2.3")?.raw).toBe("1.2.3");
    expect(parseVersion(" 1.2.3 ")?.raw).toBe("1.2.3");
    const parsed = mustParseVersion("2.0.0-rc.1+build.5");
    expect(parsed.major).toBe(2);
    expect(parsed.prerelease).toEqual(["rc", "1"]);
    expect(isPrerelease(parsed)).toBe(true);
    expect(isPrerelease(mustParseVersion("2.0.0"))).toBe(false);
  });

  it("rejects anything that is not a version", () => {
    for (const input of ["", "latest", "1.2", "1.2.3.4", "^1.2.3", "next", "1.x"]) {
      expect(parseVersion(input)).toBeUndefined();
    }
    expect(() => mustParseVersion("latest")).toThrow(/not a semantic version/);
  });
});

describe("version comparison", () => {
  const order = ["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];

  it("orders releases, with prereleases before their release", () => {
    for (let i = 0; i < order.length - 1; i += 1) {
      const left = mustParseVersion(order[i] ?? "");
      const right = mustParseVersion(order[i + 1] ?? "");
      expect(compareVersions(left, right)).toBeLessThan(0);
      expect(compareVersions(right, left)).toBeGreaterThan(0);
    }
    expect(compareVersions(mustParseVersion("1.0.0"), mustParseVersion("v1.0.0"))).toBe(0);
  });

  it("compares numeric prerelease identifiers numerically", () => {
    // The string comparison trap: "10" < "9" as text, but 10 > 9 as a number.
    expect(
      compareVersions(mustParseVersion("1.0.0-rc.9"), mustParseVersion("1.0.0-rc.10")),
    ).toBeLessThan(0);
  });

  it("finds the newest of a set", () => {
    expect(maxVersion(["1.0.0", "1.10.0", "1.9.0"].map(mustParseVersion))?.raw).toBe("1.10.0");
    expect(maxVersion([])).toBeUndefined();
  });
});

describe("pins", () => {
  it("reads exact pins and channel ranges", () => {
    expect(parsePin("1.2.3")).toMatchObject({ kind: "exact", spec: "1.2.3" });
    expect(parsePin("^1.2.3")).toMatchObject({ kind: "channel", spec: "^1.2.3" });
    expect(parsePin("~1.2.3")).toMatchObject({ kind: "channel", spec: "~1.2.3" });
    expect(parsePin("^1.2.3")?.version.raw).toBe("1.2.3");
  });

  it("refuses ranges it would have to guess at", () => {
    // Guessing wrong here upgrades a book to a release its author did not
    // choose, so anything outside the two sanctioned shapes is rejected.
    for (const spec of ["*", "", "latest", ">=1.0.0 <2.0.0", "workspace:*", "file:../cli", "1.x"]) {
      expect(parsePin(spec)).toBeUndefined();
    }
  });

  it("keeps the pin's kind when moving it to a new version", () => {
    const exact = parsePin("1.2.3");
    const caret = parsePin("^1.2.3");
    const tilde = parsePin("~1.2.3");
    const target = mustParseVersion("1.5.0");
    expect(exact === undefined ? "" : renderPin(exact, target)).toBe("1.5.0");
    expect(caret === undefined ? "" : renderPin(caret, target)).toBe("^1.5.0");
    expect(tilde === undefined ? "" : renderPin(tilde, target)).toBe("~1.5.0");
  });
});
