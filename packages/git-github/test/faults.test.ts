/**
 * Fault injection (Phase 5 contract §7). The point of every test here is
 * that a fault fires **exactly** its budgeted number of times and then the
 * fake behaves correctly again - that is what makes the writer's bounded
 * retry and the auth layer's 401 refresh testable.
 */
import { describe, expect, it } from "vitest";
import { createFakeGitHub, FakeGitHub } from "../src/testing/index.js";
import { api, commitViaApi, FAKE_APP_JWT, getInstallationToken, SAMPLE_BOOK } from "./helpers.js";

async function fixture(): Promise<{ fake: FakeGitHub; token: string }> {
  const fake = await createFakeGitHub({
    owner: "JoeMattie",
    repo: "causal-projector",
    files: SAMPLE_BOOK,
  });
  return { fake, token: await getInstallationToken(fake) };
}

describe("movedHead", () => {
  it("lands an external push between the ref read and the ref update, exactly once", async () => {
    const { fake, token } = await fixture();
    const original = fake.state.getRef("main")!;
    fake.injectFault("movedHead", {
      branch: "main",
      files: { "chapters/002-null-results.md": "externally edited\n" },
      message: "External push",
      times: 1,
    });

    // Attempt 1: the ref read returns the old head, then the push lands.
    const first = await commitViaApi(fake, { token, files: { "a.md": "a\n" } });
    expect(first.ok).toBe(false);
    expect(first.status).toBe(422);
    expect(first.message).toMatch(/not a fast forward/i);
    expect(first.headRead).toBe(original);
    // The external commit is the head, and nothing was clobbered.
    expect(fake.state.getRef("main")).not.toBe(original);
    expect(fake.fileAtHead("chapters/002-null-results.md")).toBe("externally edited\n");
    expect(fake.fileAtHead("a.md")).toBeNull();

    // Attempt 2: the fault is spent, so a reload-and-retry succeeds.
    const movedTo = fake.state.getRef("main")!;
    const second = await commitViaApi(fake, { token, files: { "a.md": "a\n" } });
    expect(second.ok).toBe(true);
    expect(second.headRead).toBe(movedTo);
    expect(fake.fileAtHead("a.md")).toBe("a\n");
    // The external edit survived the retry: no force, no clobber.
    expect(fake.fileAtHead("chapters/002-null-results.md")).toBe("externally edited\n");
    fake.assertAllFaultsFired();
  });

  it("ignores ref reads for other branches", async () => {
    const { fake, token } = await fixture();
    await fake.externalCommit({ "x.md": "x\n" }, { branch: "other" });
    fake.injectFault("movedHead", { branch: "main", files: { "z.md": "z\n" } });
    const head = fake.state.getRef("main")!;
    await api(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}/git/ref/heads/other`,
      token,
    });
    expect(fake.state.getRef("main")).toBe(head);
    // Still armed, because the fault only fires on its own branch's reads.
    expect(fake.faults.remaining("movedHead")).toBe(1);
  });

  it("honours a budget greater than one", async () => {
    const { fake, token } = await fixture();
    fake.injectFault("movedHead", { branch: "main", files: { "z.md": "z\n" }, times: 2 });
    expect((await commitViaApi(fake, { token, files: { "a.md": "a\n" } })).ok).toBe(false);
    expect((await commitViaApi(fake, { token, files: { "a.md": "a\n" } })).ok).toBe(false);
    expect((await commitViaApi(fake, { token, files: { "a.md": "a\n" } })).ok).toBe(true);
    fake.assertAllFaultsFired();
  });
});

describe("truncatedTree", () => {
  it("reports truncated: true once, then answers completely", async () => {
    const { fake, token } = await fixture();
    const treeSha = fake.state.getCommit(fake.state.getRef("main")!).tree;
    const path = `/repos/${fake.fullName}/git/trees/${treeSha}?recursive=1`;
    fake.injectFault("truncatedTree", { keepEntries: 2, times: 1 });

    const truncated = await api<{ truncated: boolean; tree: unknown[] }>(fake, {
      method: "GET",
      path,
      token,
    });
    expect(truncated.body.truncated).toBe(true);
    expect(truncated.body.tree).toHaveLength(2);

    const complete = await api<{ truncated: boolean; tree: unknown[] }>(fake, {
      method: "GET",
      path,
      token,
    });
    expect(complete.body.truncated).toBe(false);
    expect(complete.body.tree.length).toBeGreaterThan(2);
    fake.assertAllFaultsFired();
  });
});

describe("unauthorized", () => {
  it("401s repository requests once, so the auth layer refreshes and retries", async () => {
    const { fake, token } = await fixture();
    fake.injectFault("unauthorized", { times: 1 });
    const path = `/repos/${fake.fullName}/git/ref/heads/main`;

    const rejected = await api(fake, { method: "GET", path, token });
    expect(rejected.status).toBe(401);

    // A fresh token is minted; the same *old* token now works too, because
    // the fault - not the credential - was the failure.
    const refreshed = await getInstallationToken(fake);
    expect(refreshed).not.toBe(token);
    await expect(api(fake, { method: "GET", path, token: refreshed })).resolves.toMatchObject({
      status: 200,
    });
    fake.assertAllFaultsFired();
  });

  it("fires before token validation, so it works regardless of credentials", async () => {
    const { fake } = await fixture();
    fake.injectFault("unauthorized", { times: 1 });
    const result = await api(fake, { method: "GET", path: `/repos/${fake.fullName}` });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ message: "Bad credentials" });
  });
});

describe("nonFastForward", () => {
  it("422s the ref update once without any real race", async () => {
    const { fake, token } = await fixture();
    fake.injectFault("nonFastForward", { times: 1 });
    const head = fake.state.getRef("main")!;

    const first = await commitViaApi(fake, { token, files: { "a.md": "a\n" } });
    expect(first.ok).toBe(false);
    expect(first.status).toBe(422);
    expect(fake.state.getRef("main")).toBe(head);

    const second = await commitViaApi(fake, { token, files: { "a.md": "a\n" } });
    expect(second.ok).toBe(true);
    fake.assertAllFaultsFired();
  });

  it("can be exhausted to drive a bounded retry to a conflict, never a clobber", async () => {
    const { fake, token } = await fixture();
    fake.injectFault("nonFastForward", { times: 3 });
    const head = fake.state.getRef("main")!;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await commitViaApi(fake, { token, files: { "a.md": "a\n" } })).status).toBe(422);
    }
    expect(fake.state.getRef("main")).toBe(head);
    expect(fake.fileAtHead("a.md")).toBeNull();
    expect(fake.faults.remaining("nonFastForward")).toBe(0);
  });

  it("can be scoped to one branch", async () => {
    const { fake, token } = await fixture();
    await fake.externalCommit({ "x.md": "x\n" }, { branch: "other" });
    fake.injectFault("nonFastForward", { branch: "other", times: 1 });
    const result = await commitViaApi(fake, { token, files: { "a.md": "a\n" } });
    expect(result.ok).toBe(true);
    expect(fake.faults.remaining("nonFastForward")).toBe(1);
  });
});

describe("rateLimited", () => {
  it("403s with rate-limit headers once, before authentication", async () => {
    const { fake, token } = await fixture();
    fake.injectFault("rateLimited", {
      times: 1,
      retryAfterSeconds: 42,
      resetEpochSeconds: 1_800_000_000,
    });
    const path = `/repos/${fake.fullName}/git/ref/heads/main`;

    const limited = await api<{ message: string }>(fake, { method: "GET", path, token });
    expect(limited.status).toBe(403);
    expect(limited.body.message).toMatch(/rate limit/i);
    expect(limited.headers.get("retry-after")).toBe("42");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(limited.headers.get("x-ratelimit-reset")).toBe("1800000000");

    await expect(api(fake, { method: "GET", path, token })).resolves.toMatchObject({ status: 200 });
    fake.assertAllFaultsFired();
  });

  it("uses the secondary rate-limit message when asked", async () => {
    const { fake, token } = await fixture();
    fake.injectFault("rateLimited", { times: 1, secondary: true });
    const result = await api<{ message: string }>(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}`,
      token,
    });
    expect(result.body.message).toMatch(/secondary rate limit/i);
    expect(result.headers.get("retry-after")).toBeNull();
  });
});

describe("installationTokenFailure", () => {
  it("fails the token mint once, then mints normally", async () => {
    const fake = await createFakeGitHub({ files: SAMPLE_BOOK });
    fake.injectFault("installationTokenFailure", { times: 1 });
    const path = `/app/installations/${fake.installationId}/access_tokens`;

    const rejected = await api<{ message: string }>(fake, {
      method: "POST",
      path,
      token: FAKE_APP_JWT,
    });
    expect(rejected.status).toBe(401);
    expect(rejected.body.message).toBe("Bad credentials");
    expect(fake.issuedTokenCount()).toBe(0);

    await expect(getInstallationToken(fake)).resolves.toMatch(/^ghs_/);
    expect(fake.issuedTokenCount()).toBe(1);
    fake.assertAllFaultsFired();
  });

  it("can simulate a revoked installation with a 404", async () => {
    const fake = await createFakeGitHub({ files: SAMPLE_BOOK });
    fake.injectFault("installationTokenFailure", {
      times: 1,
      status: 404,
      message: "Not Found",
    });
    await expect(
      api(fake, {
        method: "POST",
        path: `/app/installations/${fake.installationId}/access_tokens`,
        token: FAKE_APP_JWT,
      }),
    ).resolves.toMatchObject({ status: 404 });
  });
});

describe("fault controller bookkeeping", () => {
  it("reports pending faults and fails loudly when one never fires", async () => {
    const { fake } = await fixture();
    fake.injectFault("truncatedTree", { times: 1 });
    expect(fake.faults.pending()).toEqual(["truncatedTree"]);
    expect(() => fake.assertAllFaultsFired()).toThrow(/truncatedTree/);
  });

  it("disarms with undefined and clears them all", async () => {
    const { fake } = await fixture();
    fake.injectFault("truncatedTree", { times: 2 });
    fake.injectFault("rateLimited", { times: 1 });
    fake.injectFault("truncatedTree", undefined);
    expect(fake.faults.remaining("truncatedTree")).toBe(0);
    fake.faults.clear();
    expect(fake.faults.pending()).toEqual([]);
    expect(() => fake.assertAllFaultsFired()).not.toThrow();
  });

  it("accepts faults armed at construction and rejects a negative budget", async () => {
    const fake = await createFakeGitHub({
      files: SAMPLE_BOOK,
      faults: { truncatedTree: { times: 1 } },
    });
    expect(fake.faults.remaining("truncatedTree")).toBe(1);
    expect(() => fake.injectFault("truncatedTree", { times: -1 })).toThrow(/non-negative/);
  });

  it("times: 0 arms nothing", async () => {
    const { fake, token } = await fixture();
    fake.injectFault("unauthorized", { times: 0 });
    await expect(
      api(fake, { method: "GET", path: `/repos/${fake.fullName}`, token }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fake.faults.pending()).toEqual([]);
  });
});
