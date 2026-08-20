const LEGACY_ORGANIZATION_PREFERENCE_KEY = "fragno-auth.default-organization-id";
const ORGANIZATION_PREFERENCE_KEY = "fragno-backoffice-default-organization";
const ORGANIZATION_PREFERENCE_EVENT = "fragno-backoffice-default-organization-change";

type OrganizationPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const browserStorage = (): OrganizationPreferenceStorage | null =>
  typeof window === "undefined" ? null : window.localStorage;

export const readPreferredOrganizationFromStorage = (
  storage: OrganizationPreferenceStorage,
): string | null => {
  const currentOrganizationId = storage.getItem(ORGANIZATION_PREFERENCE_KEY)?.trim();
  if (currentOrganizationId) {
    storage.removeItem(LEGACY_ORGANIZATION_PREFERENCE_KEY);
    return currentOrganizationId;
  }

  storage.removeItem(ORGANIZATION_PREFERENCE_KEY);
  const legacyOrganizationId = storage.getItem(LEGACY_ORGANIZATION_PREFERENCE_KEY)?.trim();
  storage.removeItem(LEGACY_ORGANIZATION_PREFERENCE_KEY);
  if (!legacyOrganizationId) {
    return null;
  }

  storage.setItem(ORGANIZATION_PREFERENCE_KEY, legacyOrganizationId);
  return legacyOrganizationId;
};

export const readPreferredOrganization = (): string | null => {
  const storage = browserStorage();
  return storage ? readPreferredOrganizationFromStorage(storage) : null;
};

export const writePreferredOrganization = (organizationId: string | null): void => {
  const storage = browserStorage();
  if (!storage) {
    return;
  }

  if (organizationId) {
    storage.setItem(ORGANIZATION_PREFERENCE_KEY, organizationId);
  } else {
    storage.removeItem(ORGANIZATION_PREFERENCE_KEY);
  }
  storage.removeItem(LEGACY_ORGANIZATION_PREFERENCE_KEY);
  window.dispatchEvent(new Event(ORGANIZATION_PREFERENCE_EVENT));
};

export const subscribeToPreferredOrganization = (listener: () => void): (() => void) => {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  window.addEventListener("storage", listener);
  window.addEventListener(ORGANIZATION_PREFERENCE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(ORGANIZATION_PREFERENCE_EVENT, listener);
  };
};
