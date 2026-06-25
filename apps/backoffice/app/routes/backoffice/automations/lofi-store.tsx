import { workflowsSchema } from "@fragno-dev/workflows/schema";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  createLofiQueryStore,
  createLofiRuntime,
  createLofiRuntimeRegistry,
  IndexedDbAdapter,
  type LofiQueryState,
  type LofiQueryStore,
  type LofiRuntime,
  type LofiRuntimeStatus,
} from "@fragno-dev/lofi";

import { backofficeScopeRouteId } from "@/backoffice-runtime/scope-codec";
import { automationFragmentSchema } from "@/fragno/automation/schema";

import type { AutomationUiScope } from "./scope";
import type { AutomationStoreItem } from "./shared";

const AUTOMATIONS_BINDINGS_ENDPOINT = "automations-bindings";

const EMPTY_QUERY_STATE: LofiQueryState<AutomationStoreItem[]> = {
  data: [],
  loading: false,
  error: null,
  synced: false,
};

const IDLE_RUNTIME_STATUS: LofiRuntimeStatus = {
  status: "idle",
  sources: {},
};

type AutomationEntriesRuntime = {
  runtime: LofiRuntime;
  $entries: LofiQueryStore<AutomationStoreItem[]>;
};

type AutomationStoreScopeRuntimeConfig = {
  scopeKey: string;
  dbName: string;
  sourceId: string;
  outboxUrl: string;
};

type ReadableStore<T> = {
  get: () => T;
  listen: (listener: (value: T) => void) => () => void;
};

const scopeRouteId = (scope: AutomationUiScope): string => {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return backofficeScopeRouteId({ kind: "org", orgId: scope.orgId });
    case "project":
      return backofficeScopeRouteId({
        kind: "project",
        orgId: scope.orgId,
        projectId: scope.projectId,
      });
    case "user":
      return backofficeScopeRouteId({ kind: "user", userId: scope.userId });
  }
};

const sanitizeScopeKeyForDatabaseName = (scopeKey: string) =>
  scopeKey.replace(/[^a-zA-Z0-9_-]+/g, "_");

const automationStoreScopeRuntimeConfig = (
  scope: AutomationUiScope,
): AutomationStoreScopeRuntimeConfig => {
  const routeId = scopeRouteId(scope);
  const scopeKey = `${scope.kind}:${routeId}`;

  return {
    scopeKey,
    dbName: `fragno_lofi_backoffice_automations_${sanitizeScopeKeyForDatabaseName(scopeKey)}`,
    sourceId: scopeKey,
    outboxUrl: `/api/automations-scoped/${scope.kind}/${encodeURIComponent(routeId)}/_internal/outbox`,
  };
};

const automationsLofiRuntimes = createLofiRuntimeRegistry({
  getKey: ({ scopeKey }: AutomationStoreScopeRuntimeConfig) => scopeKey,
  createRuntime: ({ dbName, sourceId, outboxUrl }) =>
    createLofiRuntime({
      endpointName: AUTOMATIONS_BINDINGS_ENDPOINT,
      adapter: new IndexedDbAdapter({
        dbName,
        endpointName: AUTOMATIONS_BINDINGS_ENDPOINT,
        schemas: [{ schema: automationFragmentSchema }, { schema: workflowsSchema }],
      }),
      sources: [
        {
          id: sourceId,
          outboxUrl,
        },
      ],
      outboxTransport: "stream",
      streamReconnectIntervalMs: 300,
    }),
});

const automationEntriesByScope = new Map<string, AutomationEntriesRuntime>();

const getAutomationEntriesRuntime = (
  config: AutomationStoreScopeRuntimeConfig,
): AutomationEntriesRuntime => {
  const existing = automationEntriesByScope.get(config.scopeKey);
  if (existing) {
    return existing;
  }

  const runtime = automationsLofiRuntimes.get(config);
  const $entries = createLofiQueryStore(
    runtime,
    automationFragmentSchema,
    "kv_store",
    (b) => b.whereIndex("idx_kv_store_key").orderByIndex("idx_kv_store_key", "asc"),
    {
      initialData: [],
      map: (rows) =>
        rows.map((entry) => ({
          id: entry.id.externalId,
          key: entry.key,
          value: entry.value,
          description: entry.description,
          category: Array.isArray(entry.category)
            ? entry.category.filter((item): item is string => typeof item === "string")
            : [],
          actor:
            entry.actor && typeof entry.actor === "object"
              ? (entry.actor as AutomationStoreItem["actor"])
              : null,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        })),
    },
  );
  const created = { runtime, $entries };
  automationEntriesByScope.set(config.scopeKey, created);
  return created;
};

const useNanostore = <T,>(store: ReadableStore<T> | null, fallback: T): T => {
  const subscribe = useCallback(
    (notify: () => void) => (store ? store.listen(notify) : () => undefined),
    [store],
  );
  const getSnapshot = useCallback(() => store?.get() ?? fallback, [fallback, store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const errorMessage = (error: unknown): string | null => {
  if (!error) {
    return null;
  }
  return error instanceof Error ? error.message : "Lofi sync failed.";
};

export const useLofiAutomationStoreEntries = ({
  scope,
  initialEntries,
  prefix,
}: {
  scope: AutomationUiScope;
  initialEntries: AutomationStoreItem[];
  prefix: string;
}) => {
  const scopeConfig = useMemo(() => automationStoreScopeRuntimeConfig(scope), [scope]);
  const lofi = useMemo(
    () => (typeof window === "undefined" ? null : getAutomationEntriesRuntime(scopeConfig)),
    [scopeConfig],
  );
  const queryState = useNanostore(lofi?.$entries ?? null, EMPTY_QUERY_STATE);
  const runtimeStatus = useNanostore(lofi?.runtime.$status ?? null, IDLE_RUNTIME_STATUS);
  const normalizedPrefix = prefix.trim();

  return useMemo(() => {
    const entries = queryState.data.filter(
      (entry) => !normalizedPrefix || entry.key.startsWith(normalizedPrefix),
    );
    const hasLocalData = entries.length > 0 || Boolean(runtimeStatus.lastSyncAt);

    return {
      entries: hasLocalData ? entries : initialEntries,
      synced: hasLocalData,
      error: errorMessage(queryState.error) ?? errorMessage(runtimeStatus.lastError),
    };
  }, [initialEntries, normalizedPrefix, queryState, runtimeStatus]);
};
