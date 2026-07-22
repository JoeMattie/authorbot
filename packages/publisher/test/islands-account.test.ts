// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorbotAccount } from "../site/src/islands/account.js";
import {
  getProjectStore,
  resetProjectStoresForTests,
} from "../site/src/islands/project-store.js";

if (customElements.get("authorbot-account") === undefined) {
  customElements.define("authorbot-account", AuthorbotAccount);
}

afterEach(() => {
  resetProjectStoresForTests();
  vi.unstubAllGlobals();
  document.body.textContent = "";
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("account identity", () => {
  it("renders the signed-in identity and syncs the actionable Work count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/me")) {
          return response({
            actor: { id: "actor-1", displayName: "JoeMattie", externalIdentity: "github:JoeMattie" },
            scopes: ["chapters:read", "work:read", "work:claim"],
            memberships: [{ role: "maintainer" }],
          });
        }
        if (url.includes("/work-items?status=ready")) {
          return response({ items: [{ id: "work-1" }, { id: "work-2" }], nextCursor: null });
        }
        return response({ detail: "not found" }, 404);
      }),
    );
    const badge = document.createElement("span");
    badge.dataset.workCount = "";
    badge.hidden = true;
    const account = document.createElement("authorbot-account") as AuthorbotAccount;
    account.dataset.apiBase = "http://api.test";
    account.dataset.project = "hollow-creek-anomaly";
    account.dataset.base = "/";
    document.body.append(badge, account);

    await expect.poll(() => account.querySelector(".ab-account-who")?.textContent).toBe("JoeMattie");
    await expect.poll(() => badge.textContent).toBe("2");
    expect(badge.hidden).toBe(false);
    expect(account.querySelector(".ab-account-role")?.textContent).toBe("maintainer");
    expect(account.querySelector(".ab-account-avatar")?.textContent).toBe("JO");
    expect(
      [...account.querySelectorAll<HTMLAnchorElement>(".ab-account-link")].map(
        (link) => link.textContent,
      ),
    ).toEqual(["Settings"]);
  });

  it("counts every page of ready work for the global badge", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ id: `work-${index}` }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/me")) {
          return response({
            actor: { id: "actor-3", displayName: "Editor", externalIdentity: "github:editor" },
            scopes: ["work:read"],
            memberships: [{ role: "editor" }],
          });
        }
        if (url.includes("cursor=work-49")) {
          return response({ items: [{ id: "work-50" }, { id: "work-51" }], nextCursor: null });
        }
        if (url.includes("/work-items?status=ready")) {
          return response({ items: firstPage, nextCursor: "work-49" });
        }
        return response({ detail: "not found" }, 404);
      }),
    );
    const badge = document.createElement("span");
    badge.dataset.workCount = "";
    badge.hidden = true;
    const account = document.createElement("authorbot-account") as AuthorbotAccount;
    account.dataset.apiBase = "http://api.test";
    account.dataset.project = "hollow-creek-anomaly";
    account.dataset.base = "/";
    document.body.append(badge, account);

    await expect.poll(() => badge.textContent).toBe("52");
    expect(badge.hidden).toBe(false);
  });

  it("does not probe the work queue without work read access", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        actor: { id: "actor-2", displayName: "Reader", externalIdentity: "github:reader" },
        scopes: ["chapters:read"],
        memberships: [{ role: "reader" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const account = document.createElement("authorbot-account") as AuthorbotAccount;
    account.dataset.apiBase = "http://api.test";
    account.dataset.project = "hollow-creek-anomaly";
    account.dataset.base = "/";
    document.body.append(account);

    await expect.poll(() => account.querySelector(".ab-account-who")?.textContent).toBe("Reader");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reconciles identity and clears private Work chrome after a credential change", async () => {
    let me = {
      actor: { id: "actor-old", displayName: "Old Maintainer", externalIdentity: "github:old" },
      scopes: ["work:read", "work:claim"],
      memberships: [{ role: "maintainer" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/me")) return response(me);
        if (url.includes("/work-items?status=ready")) {
          return response({ items: [{ id: "private-work" }], nextCursor: null });
        }
        return response({ detail: "not found" }, 404);
      }),
    );
    const badge = document.createElement("span");
    badge.dataset.workCount = "";
    badge.hidden = true;
    const account = document.createElement("authorbot-account") as AuthorbotAccount;
    account.dataset.apiBase = "http://api.test";
    account.dataset.project = "credential-change";
    account.dataset.base = "/";
    document.body.append(badge, account);

    await expect.poll(() => account.querySelector(".ab-account-who")?.textContent).toBe(
      "Old Maintainer",
    );
    await expect.poll(() => badge.textContent).toBe("1");

    me = {
      actor: { id: "actor-new", displayName: "New Reader", externalIdentity: "github:new" },
      scopes: ["chapters:read"],
      memberships: [{ role: "reader" }],
    };
    await getProjectStore({
      apiBase: "http://api.test",
      project: "credential-change",
    }).getState().refreshSession(true);

    await expect.poll(() => account.querySelector(".ab-account-who")?.textContent).toBe(
      "New Reader",
    );
    expect(account.querySelector(".ab-account-link")).toBeNull();
    expect(badge.textContent).toBe("0");
    expect(badge.hidden).toBe(true);
  });

  it("lets only the latest mount retain the project feed after a reconnect", async () => {
    let resolveSession!: (value: Response) => void;
    const pendingSession = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/me")) return pendingSession;
      if (url.includes("/work-items?status=ready")) {
        return response({ items: [], nextCursor: null });
      }
      return response({ detail: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = { apiBase: "http://api.test", project: "account-reconnect" };
    const store = getProjectStore(config);
    const release = vi.fn();
    const retain = vi
      .spyOn(store.getState(), "retainConnection")
      .mockReturnValue(release);
    const account = document.createElement("authorbot-account") as AuthorbotAccount;
    account.dataset.apiBase = config.apiBase;
    account.dataset.project = config.project;
    account.dataset.base = "/";
    document.body.append(account);

    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    account.remove();
    document.body.append(account);
    resolveSession(
      response({
        actor: { id: "actor-4", displayName: "Reconnected", externalIdentity: "github:again" },
        scopes: ["work:read"],
        memberships: [{ role: "editor" }],
      }),
    );

    await expect.poll(() => account.querySelector(".ab-account-who")?.textContent).toBe(
      "Reconnected",
    );
    await expect.poll(() => retain.mock.calls.length).toBe(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/v1/me"))).toHaveLength(1);
    account.remove();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
