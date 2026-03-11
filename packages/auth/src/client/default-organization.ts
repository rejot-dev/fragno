import { atom, computed, onMount, type ReadableAtom, type Store } from "nanostores";

export interface AuthMeLike {
  organizations: Array<{
    organization: {
      id: string;
      name: string;
    };
    member: {
      organizationId: string;
    };
  }>;
  activeOrganization: {
    organization: {
      id: string;
      name: string;
    };
    member: {
      organizationId: string;
    };
  } | null;
}

export type DefaultOrganizationEntry<TMe extends AuthMeLike> = TMe["organizations"][number];
export type DefaultOrganizationResolutionStatus = "reused" | "initialized" | "repaired";
export type DefaultOrganizationResolution<TMe extends AuthMeLike> = {
  status: DefaultOrganizationResolutionStatus;
  storedOrganizationId: string | null;
  resolvedOrganizationId: string;
  entry: DefaultOrganizationEntry<TMe>;
  organization: DefaultOrganizationEntry<TMe>["organization"];
  member: DefaultOrganizationEntry<TMe>["member"];
};

export const DEFAULT_ORGANIZATION_STORAGE_KEY = "fragno-auth.default-organization-id";
export const DEFAULT_ORGANIZATION_CHANGE_EVENT = "fragno-auth:default-organization-change";
export const NO_ORGANIZATIONS_ERROR_MESSAGE =
  "Authenticated users must always have at least one organization.";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type WindowLike = Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent">;

export type DefaultOrganizationMeStore<TMe extends AuthMeLike> = Store<{
  loading: boolean;
  error?: unknown;
  data?: TMe;
}>;

export type DefaultOrganizationPreferenceStore<TMe extends AuthMeLike> = {
  storageKey: string | null;
  storedOrganizationId: ReadableAtom<string | null>;
  resolution: ReadableAtom<DefaultOrganizationResolution<TMe> | null>;
  status: ReadableAtom<DefaultOrganizationResolutionStatus | null>;
  defaultOrganizationId: ReadableAtom<string | null>;
  defaultOrganization: ReadableAtom<DefaultOrganizationEntry<TMe> | null>;
  me: ReadableAtom<TMe | null>;
  loading: ReadableAtom<boolean>;
  error: ReadableAtom<unknown>;
  readDefaultOrganizationId: () => string | null;
  writeDefaultOrganizationId: (organizationId: string) => boolean;
  clearDefaultOrganizationId: () => boolean;
  syncPreference: () => DefaultOrganizationResolution<TMe> | null;
  setDefaultOrganization: (organizationId: string) => DefaultOrganizationResolution<TMe>;
};

export type DefaultOrganizationPreferenceState<TMe extends AuthMeLike> = {
  me: (params?: { sessionId?: string }) => Promise<TMe>;
  defaultOrganization: {
    storageKey: string | null;
    read: () => string | null;
    write: (organizationId: string) => boolean;
    clear: () => boolean;
    resolve: (me: TMe, storedOrganizationId: string | null) => DefaultOrganizationResolution<TMe>;
    sync: (me: TMe) => DefaultOrganizationResolution<TMe>;
    setForMe: (me: TMe, organizationId: string) => DefaultOrganizationResolution<TMe>;
  };
  store: DefaultOrganizationPreferenceStore<TMe>;
};

function getStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage != null) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getWindow(win?: WindowLike | null): WindowLike | null {
  if (win != null) {
    return win;
  }
  return typeof window !== "undefined" ? window : null;
}

function toNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function readCurrentDefaultOrganizationId(storage?: StorageLike | null): string | null {
  const s = getStorage(storage);
  if (!s) {
    return null;
  }

  return toNonEmptyString(s.getItem(getDefaultOrganizationStorageKey()));
}

export function getDefaultOrganizationStorageKey(_accountId?: string): string {
  return DEFAULT_ORGANIZATION_STORAGE_KEY;
}

export function getDefaultOrganizationChangeEventName(_accountId?: string): string {
  return DEFAULT_ORGANIZATION_CHANGE_EVENT;
}

export function readDefaultOrganizationId(
  _accountId?: string | null,
  storage?: StorageLike | null,
): string | null {
  const s = getStorage(storage);
  if (!s) {
    return null;
  }

  try {
    return readCurrentDefaultOrganizationId(s);
  } catch {
    return null;
  }
}

export function writeDefaultOrganizationId(
  _accountId: string | null | undefined,
  organizationId: string,
  storage?: StorageLike | null,
  win?: WindowLike | null,
): boolean {
  const trimmed = toNonEmptyString(organizationId);
  if (!trimmed) {
    return clearDefaultOrganizationId(_accountId, storage, win);
  }

  const s = getStorage(storage);
  const storageKey = getDefaultOrganizationStorageKey();
  const eventName = getDefaultOrganizationChangeEventName();
  if (!s) {
    return false;
  }
  if (readCurrentDefaultOrganizationId(s) === trimmed) {
    return false;
  }

  try {
    s.setItem(storageKey, trimmed);
  } catch {
    return false;
  }

  getWindow(win)?.dispatchEvent(new Event(eventName));
  return true;
}

export function clearDefaultOrganizationId(
  _accountId?: string | null,
  storage?: StorageLike | null,
  win?: WindowLike | null,
): boolean {
  const s = getStorage(storage);
  const storageKey = getDefaultOrganizationStorageKey();
  const eventName = getDefaultOrganizationChangeEventName();
  if (!s) {
    return false;
  }

  if (!readCurrentDefaultOrganizationId(s)) {
    return false;
  }

  try {
    s.removeItem(storageKey);
  } catch {
    return false;
  }

  getWindow(win)?.dispatchEvent(new Event(eventName));
  return true;
}

export function subscribeToDefaultOrganizationPreference(
  _accountId: string | null | undefined,
  onChange: () => void,
  options?: { windowObject?: WindowLike | null },
): () => void {
  const win = getWindow(options?.windowObject);
  const storageKey = getDefaultOrganizationStorageKey();
  const eventName = getDefaultOrganizationChangeEventName();
  if (!win) {
    return () => {};
  }

  const handleChange = () => onChange();
  const handleStorage = (e: Event) => {
    if (typeof StorageEvent === "undefined") {
      return onChange();
    }
    if (e instanceof StorageEvent && (!e.key || e.key === storageKey)) {
      onChange();
    }
  };

  win.addEventListener(eventName, handleChange);
  win.addEventListener("storage", handleStorage);
  return () => {
    win.removeEventListener(eventName, handleChange);
    win.removeEventListener("storage", handleStorage);
  };
}

export function findOrganizationEntry<TMe extends AuthMeLike>(
  me: TMe,
  organizationId: string | null | undefined,
): DefaultOrganizationEntry<TMe> | null {
  const id = toNonEmptyString(organizationId);
  if (!id) {
    return null;
  }
  return me.organizations.find((e) => e.organization.id === id) ?? null;
}

function toResolution<TMe extends AuthMeLike>(
  entry: DefaultOrganizationEntry<TMe>,
  status: DefaultOrganizationResolutionStatus,
  storedId: string | null,
): DefaultOrganizationResolution<TMe> {
  return {
    status,
    storedOrganizationId: storedId,
    resolvedOrganizationId: entry.organization.id,
    entry,
    organization: entry.organization,
    member: entry.member,
  };
}

export function resolveDefaultOrganization<TMe extends AuthMeLike>(
  me: TMe,
  storedOrganizationId: string | null,
): DefaultOrganizationResolution<TMe> {
  if (me.organizations.length === 0) {
    throw new Error(NO_ORGANIZATIONS_ERROR_MESSAGE);
  }

  const stored = findOrganizationEntry(me, storedOrganizationId);
  if (stored) {
    return toResolution(stored, "reused", storedOrganizationId);
  }

  const active = findOrganizationEntry(me, me.activeOrganization?.organization.id ?? null);
  const fallback = active ?? me.organizations[0];
  return toResolution(
    fallback,
    storedOrganizationId ? "repaired" : "initialized",
    storedOrganizationId,
  );
}

export function syncDefaultOrganizationPreference<TMe extends AuthMeLike>(
  _accountId: string | null | undefined,
  me: TMe,
  storage?: StorageLike | null,
  win?: WindowLike | null,
): DefaultOrganizationResolution<TMe> {
  const resolution = resolveDefaultOrganization(me, readDefaultOrganizationId(_accountId, storage));
  if (resolution.status !== "reused") {
    writeDefaultOrganizationId(_accountId, resolution.resolvedOrganizationId, storage, win);
  }
  return resolution;
}

export function setDefaultOrganizationForMe<TMe extends AuthMeLike>(
  _accountId: string | null | undefined,
  me: TMe,
  organizationId: string,
  storage?: StorageLike | null,
  win?: WindowLike | null,
): DefaultOrganizationResolution<TMe> {
  const entry = findOrganizationEntry(me, organizationId);
  if (!entry) {
    throw new Error("The selected organization is no longer available for this account.");
  }
  writeDefaultOrganizationId(_accountId, entry.organization.id, storage, win);
  return resolveDefaultOrganization(me, entry.organization.id);
}

export function createDefaultOrganizationPreferenceState<TMe extends AuthMeLike>(options: {
  meStore: DefaultOrganizationMeStore<TMe>;
  readMe: (params?: { sessionId?: string }) => Promise<TMe>;
  getAccountId?: (me: TMe) => string | null | undefined;
  storage?: StorageLike | null;
  windowObject?: WindowLike | null;
}): DefaultOrganizationPreferenceState<TMe> {
  const { meStore, readMe, storage, windowObject } = options;
  const storageVersion = atom(0);

  const refresh = () => storageVersion.set(storageVersion.get() + 1);
  const getCurrentStorageKey = () => getDefaultOrganizationStorageKey();
  const storedOrganizationId = computed(storageVersion, () =>
    readDefaultOrganizationId(null, storage),
  );

  const write = (id: string) => {
    const ok = writeDefaultOrganizationId(null, id, storage, windowObject);
    if (ok) {
      refresh();
    }
    return ok;
  };

  const clear = () => {
    const ok = clearDefaultOrganizationId(null, storage, windowObject);
    if (ok) {
      refresh();
    }
    return ok;
  };

  const syncForMe = (me: TMe) => {
    const resolution = syncDefaultOrganizationPreference(null, me, storage, windowObject);
    refresh();
    return resolution;
  };

  const setForMe = (me: TMe, id: string) => {
    const entry = findOrganizationEntry(me, id);
    if (!entry) {
      throw new Error("The selected organization is no longer available for this account.");
    }
    const resolution = setDefaultOrganizationForMe(null, me, id, storage, windowObject);
    refresh();
    return resolution;
  };

  onMount(storedOrganizationId, () =>
    subscribeToDefaultOrganizationPreference(null, refresh, { windowObject }),
  );

  const resolution = computed([meStore, storedOrganizationId], (meState, orgId) => {
    if (!meState.data) {
      return null;
    }
    return resolveDefaultOrganization(meState.data, orgId);
  });

  onMount(resolution, () =>
    resolution.listen((next) => {
      if (!next || next.status === "reused") {
        return;
      }
      if (writeDefaultOrganizationId(null, next.resolvedOrganizationId, storage, windowObject)) {
        refresh();
      }
    }),
  );

  const effectiveMe = computed([meStore, resolution], (meState) => meState.data ?? null);

  return {
    me: async (params) => {
      const me = await readMe(params);
      if (getWindow(windowObject)) {
        syncForMe(me);
      }
      return me;
    },
    defaultOrganization: {
      get storageKey() {
        return getCurrentStorageKey();
      },
      read: () => readDefaultOrganizationId(null, storage),
      write,
      clear,
      resolve: resolveDefaultOrganization,
      sync: syncForMe,
      setForMe,
    },
    store: {
      get storageKey() {
        return getCurrentStorageKey();
      },
      storedOrganizationId,
      resolution,
      status: computed(resolution, (r) => r?.status ?? null),
      defaultOrganizationId: computed(resolution, (r) => r?.resolvedOrganizationId ?? null),
      defaultOrganization: computed(resolution, (r) => r?.entry ?? null),
      me: effectiveMe,
      loading: computed(meStore, (s) => s.loading),
      error: computed(meStore, (s) => s.error),
      readDefaultOrganizationId: () => readDefaultOrganizationId(null, storage),
      writeDefaultOrganizationId: write,
      clearDefaultOrganizationId: clear,
      syncPreference: () => {
        const me = effectiveMe.get();
        return me ? syncForMe(me) : null;
      },
      setDefaultOrganization: (id) => {
        const me = effectiveMe.get();
        if (!me) {
          throw new Error("Cannot set a default organization without an authenticated user.");
        }
        return setForMe(me, id);
      },
    },
  };
}
