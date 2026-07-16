import { workflowsSchema } from "@fragno-dev/workflows/schema";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

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

import {
  backofficeScopeRouteId,
  backofficeScopeSinglePathSegment,
} from "@/backoffice-runtime/scope-codec";
import type { AutomationRouteAction } from "@/fragno/automation/routing";
import { automationFragmentSchema } from "@/fragno/automation/schema";
import {
  CLOUDFLARE_SANDBOX_PROVIDER,
  type SandboxInstanceStatus,
  type SandboxInstanceSummary,
} from "@/sandbox/contracts";

import type { AutomationUiScope } from "./scope";
import type {
  AutomationEventItem,
  AutomationLocalScopeState,
  AutomationRouteItem,
  AutomationStoreItem,
} from "./shared";

const AUTOMATIONS_BINDINGS_ENDPOINT = "automations-bindings";
const AUTOMATION_EVENTS_LOFI_PAGE_SIZE = 100;

const EMPTY_STORE_QUERY_STATE: LofiQueryState<AutomationStoreItem[]> = {
  data: [],
  loading: false,
  error: null,
  synced: false,
};

const EMPTY_ROUTES_QUERY_STATE: LofiQueryState<AutomationRouteItem[]> = {
  data: [],
  loading: false,
  error: null,
  synced: false,
};

type AutomationRouteScheduleStateItem = {
  id: string;
  nextOccurrenceAt: string | null;
};

const EMPTY_ROUTE_SCHEDULE_STATES_QUERY_STATE: LofiQueryState<AutomationRouteScheduleStateItem[]> =
  {
    data: [],
    loading: false,
    error: null,
    synced: false,
  };

const EMPTY_EVENTS_QUERY_STATE: LofiQueryState<AutomationEventItem[]> = {
  data: [],
  loading: false,
  error: null,
  synced: false,
};

const EMPTY_EVENT_DEFINITIONS_QUERY_STATE: LofiQueryState<
  AutomationLocalScopeState["eventDefinitions"]["eventDefinitions"]
> = {
  data: [],
  loading: false,
  error: null,
  synced: false,
};

const EMPTY_SANDBOXES_QUERY_STATE: LofiQueryState<SandboxInstanceSummary[]> = {
  data: [],
  loading: false,
  error: null,
  synced: false,
};

const IDLE_RUNTIME_STATUS: LofiRuntimeStatus = {
  status: "idle",
  sources: {},
};

type AutomationScopeRuntime = {
  runtime: LofiRuntime;
  $entries: LofiQueryStore<AutomationStoreItem[]>;
  $routes: LofiQueryStore<AutomationRouteItem[]>;
  $routeScheduleStates: LofiQueryStore<AutomationRouteScheduleStateItem[]>;
  $events: LofiQueryStore<AutomationEventItem[]>;
  $eventDefinitions: LofiQueryStore<
    AutomationLocalScopeState["eventDefinitions"]["eventDefinitions"]
  >;
  $sandboxes: LofiQueryStore<SandboxInstanceSummary[]>;
};

type AutomationStoreScopeRuntimeConfig = {
  scope: AutomationUiScope;
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

const sandboxIdScope = (scope: AutomationUiScope): string => {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return scope.orgId;
    case "project":
      return backofficeScopeSinglePathSegment({
        kind: "project",
        orgId: scope.orgId,
        projectId: scope.projectId,
      });
    case "user":
      return backofficeScopeSinglePathSegment({ kind: "user", userId: scope.userId });
  }
};

const toPublicSandboxId = ({
  scope,
  sandboxId,
}: {
  scope: AutomationUiScope;
  sandboxId: string;
}): string | null => {
  const prefix = `${sandboxIdScope(scope)}::`;
  return sandboxId.startsWith(prefix) ? sandboxId.slice(prefix.length) : null;
};

const toIsoString = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : value;

const isSandboxStatus = (value: string): value is SandboxInstanceStatus =>
  value === "requested" ||
  value === "starting" ||
  value === "running" ||
  value === "stopping" ||
  value === "stopped" ||
  value === "error";

const sanitizeScopeKeyForDatabaseName = (scopeKey: string) =>
  scopeKey.replace(/[^a-zA-Z0-9_-]+/g, "_");

const automationStoreScopeRuntimeConfig = (
  scope: AutomationUiScope,
): AutomationStoreScopeRuntimeConfig => {
  const routeId = scopeRouteId(scope);
  const scopeKey = `${scope.kind}:${routeId}`;

  return {
    scope,
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

const automationScopeRuntimeByScope = new Map<string, AutomationScopeRuntime>();

const getAutomationScopeRuntime = (
  config: AutomationStoreScopeRuntimeConfig,
): AutomationScopeRuntime => {
  const existing = automationScopeRuntimeByScope.get(config.scopeKey);
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
  const $routes = createLofiQueryStore(
    runtime,
    automationFragmentSchema,
    "automation_route",
    (b) => b.whereIndex("primary").orderByIndex("idx_automation_route_priority_id", "asc"),
    {
      initialData: [],
      map: (rows) =>
        rows.map((route) => ({
          id: route.id.externalId,
          name: route.name,
          enabled: route.enabled,
          priority: route.priority,
          trigger: route.trigger,
          action: route.action as AutomationRouteAction,
          description: route.description,
          nextOccurrenceAt: null,
        })),
    },
  );
  const $routeScheduleStates = createLofiQueryStore(
    runtime,
    automationFragmentSchema,
    "automation_route_schedule_state",
    (b) => b.whereIndex("primary"),
    {
      initialData: [],
      map: (rows) =>
        rows.map((state) => ({
          id: state.id.externalId,
          nextOccurrenceAt: state.nextOccurrenceAt ? toIsoString(state.nextOccurrenceAt) : null,
        })),
    },
  );
  const $events = createLofiQueryStore(
    runtime,
    automationFragmentSchema,
    "automation_event",
    (b) =>
      b
        .whereIndex("idx_automation_event_occurredAt_id")
        .orderByIndex("idx_automation_event_occurredAt_id", "desc")
        .pageSize(AUTOMATION_EVENTS_LOFI_PAGE_SIZE),
    {
      initialData: [],
      map: (rows) =>
        rows.map((event) => ({
          id: event.id.externalId,
          scope: event.scope as AutomationEventItem["scope"],
          source: event.source,
          eventType: event.eventType,
          occurredAt: toIsoString(event.occurredAt),
          payload: event.payload as AutomationEventItem["payload"],
          actor: event.actor as AutomationEventItem["actor"],
          actors: Array.isArray(event.actors)
            ? (event.actors as AutomationEventItem["actors"])
            : [],
          subject: (event.subject ?? null) as AutomationEventItem["subject"],
          createdAt: toIsoString(event.createdAt),
        })),
    },
  );
  const $eventDefinitions = createLofiQueryStore(
    runtime,
    automationFragmentSchema,
    "automation_event_definition",
    (b) =>
      b.whereIndex("primary").orderByIndex("idx_automation_event_definition_source_type", "asc"),
    {
      initialData: [],
      map: (rows) =>
        rows.map((definition) => ({
          id: definition.id.externalId,
          source: definition.source,
          eventType: definition.eventType,
          label: definition.label,
          description: definition.description,
          payloadSchema: definition.payloadSchema ?? null,
          actorSchema: definition.actorSchema ?? null,
          subjectSchema: definition.subjectSchema ?? null,
          example: definition.example ?? null,
          enabled: definition.enabled,
          capabilityId: "dynamic",
          createdAt: toIsoString(definition.createdAt),
          updatedAt: toIsoString(definition.updatedAt),
        })),
    },
  );
  const $sandboxes = createLofiQueryStore(
    runtime,
    automationFragmentSchema,
    "sandbox_instance",
    (b) => b.whereIndex("primary"),
    {
      initialData: [],
      map: (rows) =>
        rows
          .filter((instance) => instance.provider === CLOUDFLARE_SANDBOX_PROVIDER)
          .flatMap((instance) => {
            const id = toPublicSandboxId({
              scope: config.scope,
              sandboxId: instance.id.externalId,
            });
            return id && isSandboxStatus(instance.status) ? [{ id, status: instance.status }] : [];
          })
          .sort((left, right) => left.id.localeCompare(right.id)),
    },
  );
  const created = {
    runtime,
    $entries,
    $routes,
    $routeScheduleStates,
    $events,
    $eventDefinitions,
    $sandboxes,
  };
  automationScopeRuntimeByScope.set(config.scopeKey, created);
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

const hasLocalQueryResult = <TData,>(queryState: LofiQueryState<TData>): boolean =>
  queryState.synced;

export const useLofiAutomationScopeData = ({
  scope,
  initialEntries,
  initialRoutes,
  initialEvents,
  initialEventDefinitions,
  prefix,
}: {
  scope: AutomationUiScope;
  initialEntries: AutomationStoreItem[];
  initialRoutes: AutomationRouteItem[];
  initialEvents: AutomationEventItem[];
  initialEventDefinitions: AutomationLocalScopeState["eventDefinitions"]["eventDefinitions"];
  prefix: string;
}): AutomationLocalScopeState => {
  const scopeConfig = useMemo(() => automationStoreScopeRuntimeConfig(scope), [scope]);
  const lofi = useMemo(
    () => (typeof window === "undefined" ? null : getAutomationScopeRuntime(scopeConfig)),
    [scopeConfig],
  );

  useEffect(() => {
    if (!lofi) {
      return;
    }

    return lofi.runtime.retain();
  }, [lofi]);

  const entriesQueryState = useNanostore(lofi?.$entries ?? null, EMPTY_STORE_QUERY_STATE);
  const routesQueryState = useNanostore(lofi?.$routes ?? null, EMPTY_ROUTES_QUERY_STATE);
  const routeScheduleStatesQueryState = useNanostore(
    lofi?.$routeScheduleStates ?? null,
    EMPTY_ROUTE_SCHEDULE_STATES_QUERY_STATE,
  );
  const eventsQueryState = useNanostore(lofi?.$events ?? null, EMPTY_EVENTS_QUERY_STATE);
  const eventDefinitionsQueryState = useNanostore(
    lofi?.$eventDefinitions ?? null,
    EMPTY_EVENT_DEFINITIONS_QUERY_STATE,
  );
  const sandboxesQueryState = useNanostore(lofi?.$sandboxes ?? null, EMPTY_SANDBOXES_QUERY_STATE);
  const runtimeStatus = useNanostore(lofi?.runtime.$status ?? null, IDLE_RUNTIME_STATUS);
  const normalizedPrefix = prefix.trim();

  return useMemo(() => {
    const entries = entriesQueryState.data.filter(
      (entry) => !normalizedPrefix || entry.key.startsWith(normalizedPrefix),
    );
    const storeHasLocalData = hasLocalQueryResult(entriesQueryState);
    const routesHaveLocalData =
      hasLocalQueryResult(routesQueryState) && hasLocalQueryResult(routeScheduleStatesQueryState);
    const scheduleStateByRouteId = new Map(
      routeScheduleStatesQueryState.data.map((state) => [state.id, state] as const),
    );
    const routes = routesQueryState.data.map((route) => ({
      ...route,
      nextOccurrenceAt:
        route.trigger.kind === "schedule"
          ? (scheduleStateByRouteId.get(route.id)?.nextOccurrenceAt ?? null)
          : null,
    }));
    const eventsHaveLocalData = hasLocalQueryResult(eventsQueryState);
    const eventDefinitionsHaveLocalData = hasLocalQueryResult(eventDefinitionsQueryState);
    const sandboxesHaveLocalData = hasLocalQueryResult(sandboxesQueryState);
    const runtimeError = errorMessage(runtimeStatus.lastError);

    return {
      store: {
        entries: storeHasLocalData ? entries : initialEntries,
        synced: storeHasLocalData,
        error: errorMessage(entriesQueryState.error) ?? runtimeError,
      },
      routes: {
        routes: routesHaveLocalData ? routes : initialRoutes,
        synced: routesHaveLocalData,
        error:
          errorMessage(routesQueryState.error) ??
          errorMessage(routeScheduleStatesQueryState.error) ??
          runtimeError,
      },
      events: {
        events: eventsHaveLocalData ? eventsQueryState.data : initialEvents,
        synced: eventsHaveLocalData,
        error: errorMessage(eventsQueryState.error) ?? runtimeError,
      },
      eventDefinitions: {
        eventDefinitions: eventDefinitionsHaveLocalData
          ? eventDefinitionsQueryState.data
          : initialEventDefinitions,
        synced: eventDefinitionsHaveLocalData,
        error: errorMessage(eventDefinitionsQueryState.error) ?? runtimeError,
      },
      sandboxes: {
        sandboxes: sandboxesHaveLocalData ? sandboxesQueryState.data : [],
        synced: sandboxesHaveLocalData,
        error: errorMessage(sandboxesQueryState.error) ?? runtimeError,
      },
    };
  }, [
    entriesQueryState,
    eventDefinitionsQueryState,
    eventsQueryState,
    initialEntries,
    initialEventDefinitions,
    initialEvents,
    initialRoutes,
    normalizedPrefix,
    routesQueryState,
    routeScheduleStatesQueryState,
    runtimeStatus,
    sandboxesQueryState,
  ]);
};
