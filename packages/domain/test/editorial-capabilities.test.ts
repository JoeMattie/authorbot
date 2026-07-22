import { describe, expect, it } from "vitest";
import {
  EDITORIAL_CAPABILITIES,
  LEGACY_AGENT_SCOPES,
  LEGACY_CONTROL_SCOPES,
  LEGACY_EDITORIAL_SCOPES,
  ROLES,
  ROLE_EDITORIAL_CAPABILITIES,
  authorizeEditorialCapability,
  editorialCapabilitiesSchema,
  effectiveEditorialCapabilities,
  legacyEffectiveActions,
  legacyScopeShadow,
  parseEditorialCapabilities,
  parseLegacyScopes,
  parseStoredEditorialCapabilities,
  roleEditorialCapabilities,
  translateLegacyScopes,
  type EditorialCapability,
  type LegacyEditorialScope,
  type Role,
} from "../src/index.js";

const ROLE_MATRIX: Record<Role, readonly EditorialCapability[]> = {
  reader: ["chapters:read", "comments:read", "suggestions:read"],
  contributor: [
    "chapters:read",
    "comments:read",
    "suggestions:read",
    "comments:write",
    "suggestions:write",
    "replies:write",
    "comments:vote",
    "suggestions:vote",
    "feedback:withdraw-own",
  ],
  editor: [
    "chapters:read",
    "comments:read",
    "suggestions:read",
    "comments:write",
    "suggestions:write",
    "replies:write",
    "comments:vote",
    "suggestions:vote",
    "feedback:withdraw-own",
    "work:read",
    "work:claim",
    "work:submit",
    "chapters:write",
  ],
  maintainer: [...EDITORIAL_CAPABILITIES],
};

const LEGACY_TRANSLATION: Record<LegacyEditorialScope, readonly EditorialCapability[]> = {
  "chapters:read": ["chapters:read"],
  "annotations:read": ["comments:read", "suggestions:read"],
  "annotations:write": [
    "comments:write",
    "suggestions:write",
    "replies:write",
    "feedback:withdraw-own",
  ],
  "work:read": ["work:read"],
  "work:claim": ["work:claim"],
  "submissions:write": ["work:submit", "chapters:write", "chapters:publish"],
  "votes:write": ["suggestions:vote"],
};

const SHADOW_REQUIREMENTS: Record<
  LegacyEditorialScope,
  readonly EditorialCapability[]
> = {
  "chapters:read": ["chapters:read"],
  "annotations:read": ["comments:read", "suggestions:read"],
  "annotations:write": [
    "chapters:read",
    "comments:read",
    "suggestions:read",
    "comments:write",
    "suggestions:write",
    "replies:write",
    "feedback:withdraw-own",
    "feedback:moderate",
  ],
  "work:read": ["work:read"],
  "work:claim": ["work:promote", "work:claim", "work:cancel"],
  "submissions:write": ["work:submit", "chapters:write", "chapters:publish"],
  "votes:write": ["suggestions:vote"],
};

describe("canonical editorial capability vocabulary", () => {
  it("is the exact independently grantable Phase 11 slice 3 set", () => {
    expect(EDITORIAL_CAPABILITIES).toEqual([
      "chapters:read",
      "comments:read",
      "suggestions:read",
      "comments:write",
      "suggestions:write",
      "replies:write",
      "comments:vote",
      "suggestions:vote",
      "feedback:withdraw-own",
      "feedback:moderate",
      "work:read",
      "work:promote",
      "work:claim",
      "work:submit",
      "work:cancel",
      "chapters:write",
      "chapters:publish",
    ]);
  });

  it.each([
    {
      name: "canonicalizes a valid set",
      input: ["work:claim", "chapters:read", "comments:read"],
      expected: ["chapters:read", "comments:read", "work:claim"],
    },
    { name: "accepts an intentionally powerless token", input: [], expected: [] },
  ])("$name", ({ input, expected }) => {
    expect(parseEditorialCapabilities(input)).toEqual({
      ok: true,
      capabilities: expected,
    });
  });

  it.each([
    { name: "future capability", input: ["chapters:read", "history:read"] },
    { name: "control-plane scope", input: ["tokens:manage"] },
    { name: "duplicate", input: ["chapters:read", "chapters:read"] },
    { name: "mixed scalar", input: ["chapters:read", 42] },
    { name: "object", input: { capabilities: ["chapters:read"] } },
    { name: "null", input: null },
  ])("fails the complete set closed for $name", ({ input }) => {
    expect(parseEditorialCapabilities(input)).toEqual({
      ok: false,
      capabilities: [],
      reason: "invalid-capability-set",
    });
  });

  it("exposes the strict schema for request validation", () => {
    expect(editorialCapabilitiesSchema.safeParse(["comments:vote"]).success).toBe(true);
    expect(editorialCapabilitiesSchema.safeParse(["votes:write"]).success).toBe(false);
  });

  it.each([
    {
      name: "valid JSON",
      input: '["suggestions:read","chapters:read"]',
      expected: {
        ok: true,
        capabilities: ["chapters:read", "suggestions:read"],
      },
    },
    {
      name: "malformed JSON",
      input: '["chapters:read"',
      expected: { ok: false, capabilities: [], reason: "invalid-json" },
    },
    {
      name: "valid JSON with an unknown name",
      input: '["chapters:read","future:read"]',
      expected: { ok: false, capabilities: [], reason: "invalid-capability-set" },
    },
  ])("parses stored capabilities fail-closed for $name", ({ input, expected }) => {
    expect(parseStoredEditorialCapabilities(input)).toEqual(expected);
  });

  it("treats a missing canonical value as no authority", () => {
    expect(parseStoredEditorialCapabilities(null)).toEqual({
      ok: false,
      capabilities: [],
      reason: "invalid-capability-set",
    });
  });
});

describe("role capability ceilings", () => {
  it("covers the exact matrix and stays cumulative", () => {
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) {
      expect(roleEditorialCapabilities(role)).toEqual(ROLE_MATRIX[role]);
      expect(ROLE_EDITORIAL_CAPABILITIES[role]).toEqual(ROLE_MATRIX[role]);
    }
  });

  for (const role of ROLES) {
    for (const capability of EDITORIAL_CAPABILITIES) {
      const expected = ROLE_MATRIX[role].includes(capability);
      it(`${role} ${expected ? "admits" : "caps"} ${capability}`, () => {
        expect(effectiveEditorialCapabilities([capability], role)).toEqual(
          expected ? [capability] : [],
        );
      });
    }
  }

  it("raising a role activates only grants already named on the token", () => {
    const grants: EditorialCapability[] = ["chapters:read", "chapters:publish"];
    expect(effectiveEditorialCapabilities(grants, "editor")).toEqual(["chapters:read"]);
    expect(effectiveEditorialCapabilities(grants, "maintainer")).toEqual(grants);
    expect(effectiveEditorialCapabilities(["chapters:read"], "maintainer")).toEqual([
      "chapters:read",
    ]);
  });

  it("reports exact-grant failure before the independent role ceiling", () => {
    expect(authorizeEditorialCapability([], "reader", "comments:write")).toMatchObject({
      allowed: false,
      reason: "missing-capability",
    });
    expect(
      authorizeEditorialCapability(["comments:write"], "reader", "comments:write"),
    ).toMatchObject({ allowed: false, reason: "role-ceiling" });
    expect(
      authorizeEditorialCapability(
        ["comments:write"],
        "contributor",
        "comments:write",
      ).allowed,
    ).toBe(true);
  });
});

describe("legacy scope translation", () => {
  for (const scope of LEGACY_EDITORIAL_SCOPES) {
    it(`${scope} preserves exactly its exercised canonical authority`, () => {
      expect(translateLegacyScopes([scope])).toEqual(LEGACY_TRANSLATION[scope]);
    });
  }

  it("never synthesizes prerequisites absent from the legacy token", () => {
    expect(translateLegacyScopes(["annotations:write"])).not.toContain("chapters:read");
    expect(translateLegacyScopes(["annotations:write"])).not.toContain("comments:read");
    expect(translateLegacyScopes(["annotations:write"])).not.toContain("suggestions:read");
  });

  it("votes:write remains suggestion-only and cannot mint later authority", () => {
    expect(translateLegacyScopes(["votes:write"])).toEqual(["suggestions:vote"]);
    expect(translateLegacyScopes(["votes:write"])).not.toContain("comments:vote");
  });

  it.each([...LEGACY_CONTROL_SCOPES, "unknown:scope"]) (
    "%s translates to no editorial authority",
    (scope) => {
      expect(translateLegacyScopes([scope])).toEqual([]);
    },
  );

  it("all legacy combinations exclude new high-impact canonical grants", () => {
    for (let mask = 0; mask < 1 << LEGACY_AGENT_SCOPES.length; mask += 1) {
      const scopes = LEGACY_AGENT_SCOPES.filter((_, index) => (mask & (1 << index)) !== 0);
      const translated = translateLegacyScopes(scopes);
      expect(translated).not.toContain("comments:vote");
      expect(translated).not.toContain("feedback:moderate");
      expect(translated).not.toContain("work:promote");
      expect(translated).not.toContain("work:cancel");
    }
  });

  it("role ceilings still cap translated legacy grants", () => {
    const translated = translateLegacyScopes(["submissions:write"]);
    expect(effectiveEditorialCapabilities(translated, "contributor")).toEqual([]);
    expect(effectiveEditorialCapabilities(translated, "editor")).toEqual([
      "work:submit",
      "chapters:write",
    ]);
    expect(effectiveEditorialCapabilities(translated, "maintainer")).toEqual(translated);
  });

  it("sanitizes control and unknown names while retaining known editorial names", () => {
    expect(
      parseLegacyScopes([
        "annotations:read",
        "tokens:manage",
        "future:admin",
        "annotations:read",
      ]),
    ).toEqual({
      ok: true,
      scopes: ["annotations:read"],
      removedScopes: ["tokens:manage", "future:admin"],
      capabilities: ["comments:read", "suggestions:read"],
    });
  });

  it.each([null, "annotations:read", ["annotations:read", 7], { scopes: [] }])(
    "fails malformed legacy input closed without a partial grant: %j",
    (input) => {
      expect(parseLegacyScopes(input)).toEqual({
        ok: false,
        scopes: [],
        removedScopes: [],
        capabilities: [],
        reason: "invalid-legacy-scope-set",
      });
    },
  );
});

describe("legacy-only effective actions", () => {
  it.each(["reader", "contributor", "editor"] as const)(
    "%s receives no role-gated compatibility actions",
    (role) => {
      expect(legacyEffectiveActions(["annotations:write", "work:claim"], role)).toEqual([]);
    },
  );

  it("source-tags only the old maintainer behaviors", () => {
    expect(
      legacyEffectiveActions(["annotations:write", "work:claim"], "maintainer"),
    ).toEqual([
      {
        action: "feedback:moderate",
        source: "legacy-scope",
        sourceScope: "annotations:write",
      },
      {
        action: "work:promote",
        source: "legacy-scope",
        sourceScope: "work:claim",
      },
      {
        action: "work:cancel",
        source: "legacy-scope",
        sourceScope: "work:claim",
      },
    ]);
  });

  it("control-plane and unknown names never become compatibility actions", () => {
    expect(
      legacyEffectiveActions(["tokens:manage", "members:manage", "future:admin"], "maintainer"),
    ).toEqual([]);
  });
});

describe("rollback-safe legacy scope shadow", () => {
  it("emits every old editorial scope only for a fully covering canonical set", () => {
    expect(legacyScopeShadow([...EDITORIAL_CAPABILITIES])).toEqual(LEGACY_EDITORIAL_SCOPES);
  });

  for (const scope of LEGACY_EDITORIAL_SCOPES) {
    const required = SHADOW_REQUIREMENTS[scope];
    it(`${scope} is emitted when every old action is covered`, () => {
      expect(legacyScopeShadow(required)).toContain(scope);
    });

    for (const missing of required) {
      it(`${scope} is withheld without ${missing}`, () => {
        const incomplete = required.filter((capability) => capability !== missing);
        expect(legacyScopeShadow(incomplete)).not.toContain(scope);
      });
    }

    it(`${scope} cannot translate or preserve authority beyond its shadow requirements`, () => {
      const covered = new Set(required);
      for (const translated of translateLegacyScopes([scope])) {
        expect(covered.has(translated)).toBe(true);
      }
      for (const legacyAction of legacyEffectiveActions([scope], "maintainer")) {
        expect(covered.has(legacyAction.action)).toBe(true);
      }
    });
  }

  it("never emits control-plane names", () => {
    const shadow: readonly string[] = legacyScopeShadow([...EDITORIAL_CAPABILITIES]);
    for (const control of LEGACY_CONTROL_SCOPES) {
      expect(shadow).not.toContain(control);
    }
  });

  it("requires future-role safety, not merely safety at today's editor role", () => {
    const oldWriteActions: EditorialCapability[] = [
      "chapters:read",
      "comments:read",
      "suggestions:read",
      "comments:write",
      "suggestions:write",
      "replies:write",
      "feedback:withdraw-own",
    ];
    expect(legacyScopeShadow(oldWriteActions)).not.toContain("annotations:write");
    expect(legacyScopeShadow([...oldWriteActions, "feedback:moderate"])).toContain(
      "annotations:write",
    );

    expect(legacyScopeShadow(["work:claim"])).not.toContain("work:claim");
    expect(legacyScopeShadow(["work:promote", "work:claim", "work:cancel"])).toContain(
      "work:claim",
    );
  });
});
