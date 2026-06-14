import { describe, expect, it, vi, assert } from "vitest";

import { createAuthFragmentClients, getDefaultOrganizationStorageKey } from ".";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  #values = new Map<string, string>();

  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(key);
  }

  setItem(key: string, value: string) {
    this.#values.set(key, value);
  }
}

class MemoryWindow {
  localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;

  constructor(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
    this.localStorage = storage;
  }

  addEventListener() {}

  removeEventListener() {}

  dispatchEvent() {
    return true;
  }
}

describe("auth client", () => {
  it("stores bearer access tokens from auth responses and sends them on later requests", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("window", new MemoryWindow(storage));
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("removeEventListener", vi.fn());

    const customFetch = vi.fn(async (resource, init) => {
      const url = String(resource);
      if (url.endsWith("/sign-in")) {
        return {
          headers: new Headers(),
          ok: true,
          status: 200,
          clone() {
            return this;
          },
          json: async () => ({ auth: { token: "access-token-1" } }),
        };
      }

      assert(url.endsWith("/me"));
      assert(new Headers(init?.headers).get("Authorization") === "Bearer access-token-1");
      return {
        headers: new Headers(),
        ok: true,
        status: 200,
        clone() {
          return this;
        },
        json: async () => ({ user: { id: "user-1" }, organizations: [], invitations: [] }),
      };
    }) as unknown as typeof fetch;

    try {
      const clients = createAuthFragmentClients({
        auth: { accessTokens: { enabled: true, transport: "bearer" }, sessionCache: { storage } },
        fetcherConfig: { type: "function", fetcher: customFetch },
      });

      await clients.signIn.email({ email: "user@example.com", password: "password" });
      await clients.useMe.query();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the synced me wrapper to initialize default organization preference", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("window", new MemoryWindow(storage));
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("removeEventListener", vi.fn());

    const meResponse = {
      user: { id: "user-1", email: "user-1@example.com", role: "user" },
      organizations: [
        {
          organization: { id: "org-b", name: "Org B" },
          member: { organizationId: "org-b" },
        },
      ],
      activeOrganization: {
        organization: { id: "org-b", name: "Org B" },
        member: { organizationId: "org-b" },
      },
      invitations: [],
    };

    const customFetch = vi.fn(async () => ({
      headers: new Headers(),
      ok: true,
      json: async () => meResponse,
    })) as unknown as typeof fetch;

    try {
      const clients = createAuthFragmentClients({
        fetcherConfig: { type: "function", fetcher: customFetch },
      });

      expect(await clients.me()).toEqual(meResponse);
      expect(customFetch).toHaveBeenCalledOnce();
      assert(storage.getItem(getDefaultOrganizationStorageKey()) === "org-b");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
