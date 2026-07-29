import { useEffect, useSyncExternalStore } from "react";

import { automationUiScopeId, type AutomationUiScope } from "./scope";

const AUTOMATION_SCOPE_HISTORY_STORAGE_KEY = "backoffice.automations.scope-history";
const AUTOMATION_SCOPE_HISTORY_CHANGE_EVENT = "backoffice:automation-scope-history-change";
const LEGACY_AUTOMATION_CURRENT_SCOPE_STORAGE_KEY = "backoffice.automations.current-scope";
const LEGACY_AUTOMATION_LAST_SCOPE_STORAGE_KEY = "backoffice.automations.last-scope";

export type AutomationScopeHistory = {
  version: 1;
  current: AutomationUiScope;
  previous: AutomationUiScope | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseAutomationUiScope = (value: unknown): AutomationUiScope | null => {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.label !== "string") {
    return null;
  }

  switch (value.kind) {
    case "system":
      return { kind: "system", label: value.label };
    case "org":
      return typeof value.orgId === "string"
        ? { kind: "org", orgId: value.orgId, label: value.label }
        : null;
    case "project":
      return typeof value.orgId === "string" && typeof value.projectId === "string"
        ? {
            kind: "project",
            orgId: value.orgId,
            projectId: value.projectId,
            label: value.label,
          }
        : null;
    case "user":
      return typeof value.userId === "string"
        ? { kind: "user", userId: value.userId, label: value.label }
        : null;
    default:
      return null;
  }
};

export const parseAutomationScopeHistory = (
  snapshot: string | null,
): AutomationScopeHistory | null => {
  if (!snapshot) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(snapshot);
    if (!isRecord(value) || value.version !== 1) {
      return null;
    }

    const current = parseAutomationUiScope(value.current);
    const previous = value.previous === null ? null : parseAutomationUiScope(value.previous);
    if (!current || (value.previous !== null && !previous)) {
      return null;
    }

    return { version: 1, current, previous };
  } catch {
    return null;
  }
};

export const advanceAutomationScopeHistory = (
  storedHistory: AutomationScopeHistory | null,
  selectedScope: AutomationUiScope,
): AutomationScopeHistory => {
  if (!storedHistory) {
    return { version: 1, current: selectedScope, previous: null };
  }

  const selectedScopeId = automationUiScopeId(selectedScope);
  if (automationUiScopeId(storedHistory.current) !== selectedScopeId) {
    return {
      version: 1,
      current: selectedScope,
      previous: storedHistory.current,
    };
  }

  return {
    version: 1,
    current: selectedScope,
    previous:
      storedHistory.previous && automationUiScopeId(storedHistory.previous) !== selectedScopeId
        ? storedHistory.previous
        : null,
  };
};

const readAutomationScopeHistorySnapshot = () => {
  try {
    return window.sessionStorage.getItem(AUTOMATION_SCOPE_HISTORY_STORAGE_KEY);
  } catch {
    return null;
  }
};

const readServerAutomationScopeHistorySnapshot = () => null;

const subscribeToAutomationScopeHistory = (onStoreChange: () => void) => {
  const onStorageChange = (event: StorageEvent) => {
    if (event.key === AUTOMATION_SCOPE_HISTORY_STORAGE_KEY) {
      onStoreChange();
    }
  };

  window.addEventListener(AUTOMATION_SCOPE_HISTORY_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStorageChange);
  return () => {
    window.removeEventListener(AUTOMATION_SCOPE_HISTORY_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorageChange);
  };
};

const persistAutomationScopeHistory = (snapshot: string) => {
  try {
    if (window.sessionStorage.getItem(AUTOMATION_SCOPE_HISTORY_STORAGE_KEY) === snapshot) {
      return;
    }

    window.sessionStorage.setItem(AUTOMATION_SCOPE_HISTORY_STORAGE_KEY, snapshot);
    window.sessionStorage.removeItem(LEGACY_AUTOMATION_CURRENT_SCOPE_STORAGE_KEY);
    window.sessionStorage.removeItem(LEGACY_AUTOMATION_LAST_SCOPE_STORAGE_KEY);
    window.dispatchEvent(new Event(AUTOMATION_SCOPE_HISTORY_CHANGE_EVENT));
  } catch {
    // Scope navigation remains usable when browser storage is unavailable.
  }
};

export function usePreviousAutomationScope(selectedScope: AutomationUiScope) {
  const storedSnapshot = useSyncExternalStore(
    subscribeToAutomationScopeHistory,
    readAutomationScopeHistorySnapshot,
    readServerAutomationScopeHistorySnapshot,
  );
  const history = advanceAutomationScopeHistory(
    parseAutomationScopeHistory(storedSnapshot),
    selectedScope,
  );
  const nextSnapshot = JSON.stringify(history);

  useEffect(() => {
    persistAutomationScopeHistory(nextSnapshot);
  }, [nextSnapshot]);

  return history.previous;
}
