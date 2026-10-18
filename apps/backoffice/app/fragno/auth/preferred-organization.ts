import { useSyncExternalStore } from "react";

import type { BackofficeMeData } from "./contracts";

/** A navigation preference never grants access or widens a credential's scope. */
export function usePreferredOrganization(): string | null {
  return useSyncExternalStore(
    subscribeToPreferredOrganization,
    readPreferredOrganization,
    () => null,
  );
}

/** Discards a saved preference when it no longer belongs to the user's organizations. */
export function resolvePreferredOrganizationId(
  me: BackofficeMeData,
  storedOrganizationId: string | null,
): string | null {
  return me.organizations.some((entry) => entry.organization.id === storedOrganizationId)
    ? storedOrganizationId
    : (me.activeOrganization?.organization.id ?? me.organizations[0]?.organization.id ?? null);
}

const ORGANIZATION_PREFERENCE_KEY = "fragno-backoffice-default-organization";
const ORGANIZATION_PREFERENCE_EVENT = "fragno-backoffice-default-organization-change";

type OrganizationPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const browserStorage = (): OrganizationPreferenceStorage | null =>
  typeof window === "undefined" ? null : window.localStorage;

export const readPreferredOrganizationFromStorage = (
  storage: OrganizationPreferenceStorage,
): string | null => {
  const organizationId = storage.getItem(ORGANIZATION_PREFERENCE_KEY)?.trim();
  if (organizationId) {
    return organizationId;
  }

  storage.removeItem(ORGANIZATION_PREFERENCE_KEY);
  return null;
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
