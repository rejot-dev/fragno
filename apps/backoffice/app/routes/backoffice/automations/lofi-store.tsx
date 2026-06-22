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

import { automationFragmentSchema } from "@/fragno/automation/schema";

import type { AutomationStoreItem } from "./shared";

const AUTOMATIONS_BINDINGS_ENDPOINT = "automations-bindings";

const EMPTY_QUERY_STATE: LofiQueryState<AutomationStoreItem[]> = {
  data: [],
  loading: false,
  error: null,
  synced: false,
};

const IDLE_RUNTIME_STATUS: LofiRuntimeStatus = {
  running: false,
  syncing: false,
  sources: {},
};

type AutomationEntriesRuntime = {
  runtime: LofiRuntime;
  $entries: LofiQueryStore<AutomationStoreItem[]>;
};

type ReadableStore<T> = {
  get: () => T;
  listen: (listener: (value: T) => void) => () => void;
};

const automationsLofiRuntimes = createLofiRuntimeRegistry({
  getKey: ({ orgId }: { orgId: string }) => orgId,
  createRuntime: ({ orgId }) =>
    createLofiRuntime({
      endpointName: AUTOMATIONS_BINDINGS_ENDPOINT,
      adapter: new IndexedDbAdapter({
        dbName: `fragno_lofi_backoffice_automations_${orgId}`,
        endpointName: AUTOMATIONS_BINDINGS_ENDPOINT,
        schemas: [{ schema: automationFragmentSchema }, { schema: workflowsSchema }],
      }),
      sources: [
        {
          id: orgId,
          outboxUrl: `/api/automations/${encodeURIComponent(orgId)}/_internal/outbox`,
        },
      ],
      outboxTransport: "stream",
      streamReconnectIntervalMs: 300,
    }),
});

const automationEntriesByOrg = new Map<string, AutomationEntriesRuntime>();

const getAutomationEntriesRuntime = (orgId: string): AutomationEntriesRuntime => {
  const existing = automationEntriesByOrg.get(orgId);
  if (existing) {
    return existing;
  }

  const runtime = automationsLofiRuntimes.get({ orgId });
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
  automationEntriesByOrg.set(orgId, created);
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
  orgId,
  initialEntries,
  prefix,
}: {
  orgId: string;
  initialEntries: AutomationStoreItem[];
  prefix: string;
}) => {
  const lofi = useMemo(
    () => (typeof window === "undefined" ? null : getAutomationEntriesRuntime(orgId)),
    [orgId],
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
