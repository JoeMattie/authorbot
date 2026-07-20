import { describe, expect, it } from "vitest";
import {
  ROLES,
  ROLE_SCOPES,
  SCOPES,
  effectiveScopes,
  requireScope,
  requireScopes,
  roleScopes,
  type Role,
  type Scope,
} from "../src/index.js";

/** Expected role × scope matrix straight from the Phase 2 contract section 3. */
const MATRIX: Record<Role, Record<Scope, boolean>> = {
  reader: {
    "chapters:read": true,
    "annotations:read": true,
    "annotations:write": false,
    "work:read": false,
    "work:claim": false,
    "submissions:write": false,
    "tokens:manage": false,
    "members:manage": false,
  },
  contributor: {
    "chapters:read": true,
    "annotations:read": true,
    "annotations:write": true,
    "work:read": false,
    "work:claim": false,
    "submissions:write": false,
    "tokens:manage": false,
    "members:manage": false,
  },
  editor: {
    "chapters:read": true,
    "annotations:read": true,
    "annotations:write": true,
    "work:read": true,
    "work:claim": true,
    "submissions:write": true,
    "tokens:manage": false,
    "members:manage": false,
  },
  maintainer: {
    "chapters:read": true,
    "annotations:read": true,
    "annotations:write": true,
    "work:read": true,
    "work:claim": true,
    "submissions:write": true,
    "tokens:manage": true,
    "members:manage": true,
  },
};

describe("role scope bundles", () => {
  it("covers every role and every known scope in the matrix", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) {
      expect(Object.keys(MATRIX[role]).sort()).toEqual([...SCOPES].sort());
    }
  });

  for (const role of ROLES) {
    for (const scope of SCOPES) {
      const expected = MATRIX[role][scope];
      it(`${role} ${expected ? "has" : "lacks"} ${scope}`, () => {
        expect(roleScopes(role).includes(scope)).toBe(expected);
      });
    }
  }

  it("bundles are cumulative (reader ⊂ contributor ⊂ editor ⊂ maintainer)", () => {
    const chain: Role[] = ["reader", "contributor", "editor", "maintainer"];
    for (let i = 1; i < chain.length; i += 1) {
      const smaller = ROLE_SCOPES[chain[i - 1] as Role];
      const larger = new Set(ROLE_SCOPES[chain[i] as Role]);
      for (const scope of smaller) {
        expect(larger.has(scope)).toBe(true);
      }
      expect(larger.size).toBeGreaterThan(smaller.length - 1);
    }
  });

  it("maintainer bundle equals the full known-scope set", () => {
    expect([...ROLE_SCOPES.maintainer].sort()).toEqual([...SCOPES].sort());
  });
});

describe("effectiveScopes", () => {
  it("is the intersection of token scopes and the role bundle", () => {
    expect(
      effectiveScopes(["annotations:write", "tokens:manage"], "contributor"),
    ).toEqual(["annotations:write"]);
  });

  it("a broad token held by a reader-membership agent collapses to the reader bundle", () => {
    expect(effectiveScopes([...SCOPES], "reader")).toEqual([
      "chapters:read",
      "annotations:read",
    ]);
  });

  it("a narrow token held by a maintainer stays narrow", () => {
    expect(effectiveScopes(["chapters:read"], "maintainer")).toEqual([
      "chapters:read",
    ]);
  });

  it("empty token scopes yield no effective scopes", () => {
    expect(effectiveScopes([], "maintainer")).toEqual([]);
  });

  it("deduplicates and returns canonical order", () => {
    expect(
      effectiveScopes(
        ["annotations:read", "chapters:read", "annotations:read"],
        "maintainer",
      ),
    ).toEqual(["chapters:read", "annotations:read"]);
  });

  it("intersection matrix: every token-scope × role pair", () => {
    for (const role of ROLES) {
      for (const scope of SCOPES) {
        const effective = effectiveScopes([scope], role);
        expect(effective).toEqual(MATRIX[role][scope] ? [scope] : []);
      }
    }
  });
});

describe("requireScope", () => {
  it("allows when the scope is present", () => {
    const decision = requireScope(["chapters:read", "annotations:read"], "chapters:read");
    expect(decision.allowed).toBe(true);
  });

  it("denies with missing-scope when absent", () => {
    const decision = requireScope(["chapters:read"], "annotations:write");
    expect(decision).toMatchObject({ allowed: false, reason: "missing-scope" });
    if (!decision.allowed) {
      expect(decision.message).toContain("annotations:write");
    }
  });

  it("denies on empty actor scopes", () => {
    expect(requireScope([], "chapters:read").allowed).toBe(false);
  });
});

describe("requireScopes", () => {
  it("allows when every scope is present", () => {
    expect(
      requireScopes(["chapters:read", "annotations:read"], ["annotations:read", "chapters:read"])
        .allowed,
    ).toBe(true);
  });

  it("allows an empty requirement", () => {
    expect(requireScopes([], []).allowed).toBe(true);
  });

  it("denies naming the missing scope", () => {
    const decision = requireScopes(["chapters:read"], ["chapters:read", "tokens:manage"]);
    expect(decision).toMatchObject({ allowed: false, reason: "missing-scope" });
    if (!decision.allowed) {
      expect(decision.message).toContain("tokens:manage");
    }
  });
});
