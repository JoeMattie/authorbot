/**
 * The annotation policy decision table (Phase 7 contract "Restricting").
 *
 * Exhaustive rather than illustrative: the rule is enforced server-side and the
 * cost of a hole in it is a stranger writing to a locked book, so every
 * combination of mode × credential × role × capability is asserted rather than
 * a representative sample.
 */
import { describe, expect, it } from "vitest";
import { ANNOTATION_POLICY_MODES } from "@authorbot/schemas";
import {
  ANNOTATION_POLICIES,
  DEFAULT_ANNOTATION_POLICY,
  checkAnnotationPolicy,
  isAnnotationPolicy,
  policyRequiresApproval,
  type AnnotationPolicy,
  type PolicyCapability,
} from "../src/annotation-policy.js";
import { ROLES, type Role } from "../src/scopes.js";

const CAPABILITIES: PolicyCapability[] = ["annotate", "vote", "claim", "submit"];

const allow = (
  policy: AnnotationPolicy,
  credential: "session" | "token" | null,
  role: Role | null,
  capability: PolicyCapability,
): boolean => checkAnnotationPolicy({ policy, credential, role, capability }).allowed;

describe("annotation policy vocabulary", () => {
  it("matches the book.yml schema's enum exactly", () => {
    // The two lists are declared independently (`@authorbot/schemas` is the
    // leaf package and must not depend on the domain rules), so something has
    // to pin them together. This is that something.
    expect([...ANNOTATION_POLICIES].sort()).toEqual([...ANNOTATION_POLICY_MODES].sort());
  });

  it("defaults to the Phase 2 behaviour, not to either extreme", () => {
    // A deployment upgrading into Phase 7 must not find its book suddenly
    // writable by strangers — nor its existing collaborators locked out.
    expect(DEFAULT_ANNOTATION_POLICY).toBe("collaborators-only");
  });

  it("recognizes exactly the four modes", () => {
    for (const mode of ANNOTATION_POLICIES) expect(isAnnotationPolicy(mode)).toBe(true);
    for (const other of ["", "OPEN", "public", "off", "disabled", null, 3, {}]) {
      expect(isAnnotationPolicy(other)).toBe(false);
    }
  });

  it("queues writes for review under approval-gated and nowhere else", () => {
    for (const mode of ANNOTATION_POLICIES) {
      expect(policyRequiresApproval(mode)).toBe(mode === "approval-gated");
    }
  });
});

describe("anonymous writing (contract: unavailable in EVERY mode)", () => {
  it("is refused in every mode, for every capability — `open` included", () => {
    for (const policy of ANNOTATION_POLICIES) {
      for (const capability of CAPABILITIES) {
        const decision = checkAnnotationPolicy({
          policy,
          credential: null,
          role: null,
          capability,
        });
        expect(decision.allowed, `${policy}/${capability}`).toBe(false);
        if (!decision.allowed) expect(decision.reason).toBe("anonymous");
      }
    }
  });

  it("refuses anonymity even when a role is somehow supplied", () => {
    // Belt and braces: the credential check runs FIRST precisely so that no
    // later branch can accidentally admit a role-bearing, credential-less
    // request.
    const decision = checkAnnotationPolicy({
      policy: "open",
      credential: null,
      role: "maintainer",
      capability: "annotate",
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("locked — author-only, NOT off", () => {
  it("admits maintainers on every capability, by session or by token", () => {
    // "The book remains fully usable by its maintainers: annotating their own
    // drafts … and running their own agents against their own ideas."
    for (const capability of CAPABILITIES) {
      expect(allow("locked", "session", "maintainer", capability)).toBe(true);
      expect(allow("locked", "token", "maintainer", capability)).toBe(true);
    }
  });

  it("refuses every non-maintainer role, including editors and contributors", () => {
    for (const role of ROLES.filter((r) => r !== "maintainer")) {
      for (const capability of CAPABILITIES) {
        const decision = checkAnnotationPolicy({
          policy: "locked",
          credential: "session",
          role,
          capability,
        });
        expect(decision.allowed, `${role}/${capability}`).toBe(false);
        if (!decision.allowed) expect(decision.reason).toBe("locked");
      }
    }
  });

  it("explains that membership and history survive the lock", () => {
    const decision = checkAnnotationPolicy({
      policy: "locked",
      credential: "session",
      role: "contributor",
      capability: "annotate",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // The refusal has to say this: a collaborator who reads "you cannot
      // write" and infers "I have been removed" is being misinformed by the
      // system about their own standing.
      expect(decision.message).toMatch(/keep their membership and their history/i);
      expect(decision.message).toMatch(/may write again/i);
    }
  });

  it("refuses a token whose membership is merely editor — the grant is the point", () => {
    // An author's agent works under `locked` by holding a MAINTAINER
    // membership, deliberately granted. An ordinary editor-role agent — which
    // is what minting produces by default — does not get in.
    expect(allow("locked", "token", "editor", "annotate")).toBe(false);
    expect(allow("locked", "token", "maintainer", "annotate")).toBe(true);
  });
});

describe("collaborators-only — the default", () => {
  it("admits every member role on every capability", () => {
    for (const role of ROLES) {
      for (const capability of CAPABILITIES) {
        expect(allow("collaborators-only", "session", role, capability)).toBe(true);
      }
    }
  });

  it("refuses signed-in non-members", () => {
    const decision = checkAnnotationPolicy({
      policy: "collaborators-only",
      credential: "session",
      role: null,
      capability: "annotate",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("members-only");
  });
});

describe("open and approval-gated — widened, but only where the contract says", () => {
  for (const policy of ["open", "approval-gated"] as const) {
    it(`${policy}: admits a signed-in non-member to annotate`, () => {
      expect(allow(policy, "session", null, "annotate")).toBe(true);
    });

    it(`${policy}: does NOT hand a non-member the collaborator capabilities`, () => {
      // "any signed-in GitHub user may comment/suggest" — a book that welcomes
      // comments from the internet is not thereby handing the internet its
      // governance votes or its work queue.
      for (const capability of ["vote", "claim", "submit"] as const) {
        const decision = checkAnnotationPolicy({
          policy,
          credential: "session",
          role: null,
          capability,
        });
        expect(decision.allowed, capability).toBe(false);
        if (!decision.allowed) expect(decision.reason).toBe("member-capability");
      }
    });

    it(`${policy}: does NOT admit an unenrolled agent token`, () => {
      // The contract's "deliberate grant rather than an implicit inheritance
      // from their owner". A permissive policy describes signed-in PEOPLE.
      const decision = checkAnnotationPolicy({
        policy,
        credential: "token",
        role: null,
        capability: "annotate",
      });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe("members-only");
    });

    it(`${policy}: admits every enrolled member exactly as before`, () => {
      for (const role of ROLES) {
        for (const capability of CAPABILITIES) {
          expect(allow(policy, "session", role, capability), `${role}/${capability}`).toBe(true);
          expect(allow(policy, "token", role, capability), `token ${role}/${capability}`).toBe(
            true,
          );
        }
      }
    });
  }
});

describe("the progression is monotonic in who it admits", () => {
  it("never refuses a maintainer in any mode", () => {
    // The author must never be locked out of their own book by their own
    // policy — that is the difference between a restriction and a footgun.
    for (const policy of ANNOTATION_POLICIES) {
      for (const capability of CAPABILITIES) {
        expect(allow(policy, "session", "maintainer", capability), policy).toBe(true);
      }
    }
  });

  it("admits strictly more people as it moves from locked toward open", () => {
    const admitted = (policy: AnnotationPolicy): number => {
      let count = 0;
      for (const credential of ["session", "token"] as const) {
        for (const role of [...ROLES, null]) {
          for (const capability of CAPABILITIES) {
            if (allow(policy, credential, role, capability)) count += 1;
          }
        }
      }
      return count;
    };
    expect(admitted("locked")).toBeLessThan(admitted("collaborators-only"));
    expect(admitted("collaborators-only")).toBeLessThan(admitted("open"));
    // `open` and `approval-gated` admit the same people; they differ only in
    // when what those people write becomes visible.
    expect(admitted("approval-gated")).toBe(admitted("open"));
  });
});
