import { atom } from "nanostores";
import { describe, expect, test, vi } from "vitest";
import {
  NO_ORGANIZATIONS_ERROR_MESSAGE,
  clearDefaultOrganizationId,
  createDefaultOrganizationPreferenceState,
  getDefaultOrganizationStorageKey,
  readDefaultOrganizationId,
  resolveDefaultOrganization,
  setDefaultOrganizationForMe,
  subscribeToDefaultOrganizationPreference,
  syncDefaultOrganizationPreference,
  writeDefaultOrganizationId,
  type AuthMeLike,
} from "./default-organization";

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

class MemoryWindow
  implements Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent">
{
  #listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    if (!callback) {
      return;
    }
    const listeners = this.#listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(callback);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    if (!callback) {
      return;
    }
    this.#listeners.get(type)?.delete(callback);
  }

  dispatchEvent(event: Event) {
    for (const listener of this.#listeners.get(event.type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
    return true;
  }
}

type TestAuthMeData = AuthMeLike & {
  user: { id: string; email: string; role: "user" };
  invitations: [];
};

function createMe(options?: {
  organizationIds?: string[];
  activeOrganizationId?: string | null;
  userId?: string;
}): TestAuthMeData {
  const organizationIds = options?.organizationIds ?? ["org-a", "org-b"];
  const userId = options?.userId ?? "user-1";
  const createdAt = "2026-03-10T00:00:00.000Z";
  const organizations = organizationIds.map((organizationId, index) => ({
    organization: {
      id: organizationId,
      name: `Org ${index + 1}`,
      slug: `org-${index + 1}`,
      logoUrl: null,
      metadata: null,
      createdBy: userId,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    },
    member: {
      id: `member-${organizationId}`,
      organizationId,
      userId,
      roles: ["owner"],
      createdAt,
      updatedAt: createdAt,
    },
  }));
  const activeEntry =
    options?.activeOrganizationId == null
      ? null
      : (organizations.find((e) => e.organization.id === options.activeOrganizationId) ?? null);

  return {
    user: { id: userId, email: `${userId}@example.com`, role: "user" },
    organizations,
    activeOrganization: activeEntry
      ? { organization: activeEntry.organization, member: activeEntry.member }
      : null,
    invitations: [],
  };
}

describe("default organization helpers", () => {
  test("reuses a stored organization when it is still valid", () => {
    const me = createMe({ activeOrganizationId: "org-b" });
    const resolution = resolveDefaultOrganization(me, "org-a");
    expect(resolution.status).toBe("reused");
    expect(resolution.resolvedOrganizationId).toBe("org-a");
    expect(resolution.organization.id).toBe("org-a");
  });

  test("initializes from the active organization when no preference is stored", () => {
    const me = createMe({ activeOrganizationId: "org-b" });
    const resolution = resolveDefaultOrganization(me, null);
    expect(resolution.status).toBe("initialized");
    expect(resolution.resolvedOrganizationId).toBe("org-b");
  });

  test("repairs a stale stored organization with the active organization when available", () => {
    const me = createMe({ activeOrganizationId: "org-b" });
    const resolution = resolveDefaultOrganization(me, "org-missing");
    expect(resolution.status).toBe("repaired");
    expect(resolution.resolvedOrganizationId).toBe("org-b");
  });

  test("repairs a stale stored organization with the first membership when no active org exists", () => {
    const me = createMe({ activeOrganizationId: null });
    const resolution = resolveDefaultOrganization(me, "org-missing");
    expect(resolution.status).toBe("repaired");
    expect(resolution.resolvedOrganizationId).toBe("org-a");
  });

  test("syncs and updates the stored preference", () => {
    const storage = new MemoryStorage();
    const me = createMe({ activeOrganizationId: "org-b" });
    const accountId = me.user.id;

    expect(writeDefaultOrganizationId(accountId, "org-a", storage)).toBe(true);
    expect(readDefaultOrganizationId(accountId, storage)).toBe("org-a");

    const repaired = syncDefaultOrganizationPreference(accountId, me, storage);
    expect(repaired.status).toBe("reused");
    expect(readDefaultOrganizationId(accountId, storage)).toBe("org-a");

    const updated = setDefaultOrganizationForMe(accountId, me, "org-b", storage);
    expect(updated.resolvedOrganizationId).toBe("org-b");
    expect(readDefaultOrganizationId(accountId, storage)).toBe("org-b");

    expect(clearDefaultOrganizationId(accountId, storage)).toBe(true);
    expect(readDefaultOrganizationId(accountId, storage)).toBeNull();
  });

  test("returns null when storage is unavailable", () => {
    expect(readDefaultOrganizationId("user-1", null)).toBeNull();
  });

  test("returns null when window.localStorage access throws", () => {
    const blockedWindow = {};

    Object.defineProperty(blockedWindow, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    vi.stubGlobal("window", blockedWindow);

    try {
      expect(readDefaultOrganizationId("user-1")).toBeNull();
      expect(writeDefaultOrganizationId("user-1", "org-a")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("uses a single global storage key across accounts", () => {
    const storage = new MemoryStorage();

    expect(getDefaultOrganizationStorageKey("user-1")).toBe(
      getDefaultOrganizationStorageKey("user-2"),
    );
    expect(writeDefaultOrganizationId("user-1", "org-a", storage)).toBe(true);
    expect(readDefaultOrganizationId("user-1", storage)).toBe("org-a");
    expect(readDefaultOrganizationId("user-2", storage)).toBe("org-a");

    expect(writeDefaultOrganizationId("user-2", "org-b", storage)).toBe(true);
    expect(readDefaultOrganizationId("user-1", storage)).toBe("org-b");
    expect(readDefaultOrganizationId("user-2", storage)).toBe("org-b");
  });

  test("notifies all listeners because the preference is global", () => {
    const storage = new MemoryStorage();
    const windowObject = new MemoryWindow();
    let userOneChanges = 0;
    let userTwoChanges = 0;

    const unsubscribeUserOne = subscribeToDefaultOrganizationPreference(
      "user-1",
      () => {
        userOneChanges += 1;
      },
      { windowObject },
    );
    const unsubscribeUserTwo = subscribeToDefaultOrganizationPreference(
      "user-2",
      () => {
        userTwoChanges += 1;
      },
      { windowObject },
    );

    expect(writeDefaultOrganizationId("user-1", "org-a", storage, windowObject)).toBe(true);
    expect(userOneChanges).toBe(1);
    expect(userTwoChanges).toBe(1);

    expect(writeDefaultOrganizationId("user-2", "org-b", storage, windowObject)).toBe(true);
    expect(userOneChanges).toBe(2);
    expect(userTwoChanges).toBe(2);

    unsubscribeUserOne();
    unsubscribeUserTwo();
  });

  test("throws loudly when no organizations are available", () => {
    const me = createMe({ organizationIds: [], activeOrganizationId: null });
    expect(() => resolveDefaultOrganization(me, null)).toThrow(NO_ORGANIZATIONS_ERROR_MESSAGE);
  });
});

describe("createDefaultOrganizationPreferenceState", () => {
  test("builds a reactive store that syncs the default organization", () => {
    const storage = new MemoryStorage();
    const windowObject = new MemoryWindow();
    const me = createMe({ activeOrganizationId: "org-b" });
    const meStore = atom<{ loading: boolean; error?: unknown; data?: TestAuthMeData }>({
      loading: false,
      data: me,
    });
    const state = createDefaultOrganizationPreferenceState({
      meStore,
      readMe: async () => me,
      getAccountId: (value) => value.user.id,
      storage,
      windowObject,
    });

    const unsubscribe = state.store.me.listen(() => {});

    expect(state.defaultOrganization.storageKey).toBe(getDefaultOrganizationStorageKey(me.user.id));
    expect(state.store.storageKey).toBe(getDefaultOrganizationStorageKey(me.user.id));
    expect(state.store.defaultOrganizationId.get()).toBe("org-b");
    expect(state.store.me.get()?.activeOrganization?.organization.id).toBe("org-b");
    expect(readDefaultOrganizationId(me.user.id, storage)).toBe("org-b");

    const updated = state.store.setDefaultOrganization("org-a");

    expect(updated.resolvedOrganizationId).toBe("org-a");
    expect(state.store.defaultOrganizationId.get()).toBe("org-a");
    expect(state.store.defaultOrganization.get()?.organization.id).toBe("org-a");
    expect(state.store.me.get()?.activeOrganization?.organization.id).toBe("org-b");
    expect(readDefaultOrganizationId(me.user.id, storage)).toBe("org-a");

    unsubscribe();
  });

  test("keeps non-reactive me reads session-backed while syncing preference state", async () => {
    const storage = new MemoryStorage();
    const windowObject = new MemoryWindow();
    const me = createMe({ activeOrganizationId: "org-b" });

    writeDefaultOrganizationId(me.user.id, "org-a", storage, windowObject);

    const state = createDefaultOrganizationPreferenceState({
      meStore: atom<{ loading: boolean; error?: unknown; data?: TestAuthMeData }>({
        loading: false,
        data: me,
      }),
      readMe: async () => me,
      getAccountId: (value) => value.user.id,
      storage,
      windowObject,
    });

    const normalizedMe = await state.me();

    expect(normalizedMe.activeOrganization?.organization.id).toBe("org-b");
    expect(state.store.defaultOrganizationId.get()).toBe("org-a");
  });

  test("initializes the preference store from storage", () => {
    const storage = new MemoryStorage();
    const me = createMe({ activeOrganizationId: "org-b" });

    writeDefaultOrganizationId(me.user.id, "org-a", storage);

    const state = createDefaultOrganizationPreferenceState({
      meStore: atom<{ loading: boolean; error?: unknown; data?: TestAuthMeData }>({
        loading: false,
        data: me,
      }),
      readMe: async () => me,
      getAccountId: (value) => value.user.id,
      storage,
    });

    const unsubscribe = state.store.me.listen(() => {});

    expect(state.store.storedOrganizationId.get()).toBe("org-a");
    expect(state.store.defaultOrganizationId.get()).toBe("org-a");

    unsubscribe();
  });

  test("exposes a stored preference before an authenticated account is loaded", () => {
    const storage = new MemoryStorage();

    writeDefaultOrganizationId(null, "org-a", storage);

    const state = createDefaultOrganizationPreferenceState({
      meStore: atom<{ loading: boolean; error?: unknown; data?: TestAuthMeData }>({
        loading: false,
      }),
      readMe: async () => createMe({ activeOrganizationId: "org-a" }),
      storage,
    });

    expect(state.defaultOrganization.storageKey).toBe(getDefaultOrganizationStorageKey());
    expect(state.defaultOrganization.read()).toBe("org-a");
    expect(state.store.readDefaultOrganizationId()).toBe("org-a");
  });

  test("keeps a single shared preference when the authenticated account changes", () => {
    const storage = new MemoryStorage();
    const windowObject = new MemoryWindow();
    const meA = createMe({
      userId: "user-a",
      organizationIds: ["org-a", "org-b", "org-c"],
      activeOrganizationId: "org-a",
    });
    const meB = createMe({
      userId: "user-b",
      organizationIds: ["org-a", "org-b", "org-c"],
      activeOrganizationId: "org-b",
    });

    writeDefaultOrganizationId(meA.user.id, "org-a", storage, windowObject);

    const meStore = atom<{ loading: boolean; error?: unknown; data?: TestAuthMeData }>({
      loading: false,
      data: meA,
    });
    const state = createDefaultOrganizationPreferenceState({
      meStore,
      readMe: async () => meStore.get().data as TestAuthMeData,
      getAccountId: (value) => value.user.id,
      storage,
      windowObject,
    });

    const unsubscribe = state.store.me.listen(() => {});

    expect(state.store.storageKey).toBe(getDefaultOrganizationStorageKey(meA.user.id));
    expect(state.store.storedOrganizationId.get()).toBe("org-a");

    meStore.set({ loading: false, data: meB });

    expect(state.store.storageKey).toBe(getDefaultOrganizationStorageKey(meB.user.id));
    expect(state.store.storedOrganizationId.get()).toBe("org-a");

    state.store.setDefaultOrganization("org-c");

    expect(readDefaultOrganizationId(meA.user.id, storage)).toBe("org-c");
    expect(readDefaultOrganizationId(meB.user.id, storage)).toBe("org-c");

    unsubscribe();
  });
});
