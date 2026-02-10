import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OutboxEntry, SyncCommandDefinition, SyncCommandRegistry } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import {
  decodeOutboxPayload,
  IndexedDbAdapter,
  LofiClient,
  LofiSubmitClient,
} from "@fragno-dev/lofi";
import { commentSyncCommands } from "@fragno-dev/fragno-db-library";
import { ratingSyncCommands } from "@fragno-dev/fragno-db-library/upvote";
import { commentSchema, upvoteSchema } from "@fragno-dev/fragno-db-library/schema";

type SchemaDescriptor = {
  name: string;
  namespace: string | null;
  version: number;
  tables: string[];
};

type InternalDescribeResponse = {
  adapterIdentity: string;
  fragments: { name: string; mountRoute: string }[];
  schemas: SchemaDescriptor[];
  routes: { internal: "/_internal"; outbox?: "/_internal/outbox" };
};

type InternalDescribeError = {
  error: { code: string; message: string; detail?: string };
};

type EndpointConfig = {
  id: string;
  label: string;
  baseUrl: string;
  pollIntervalMs: number;
  enabled: boolean;
};

type AppTab = "tables" | "endpoints" | "commands";

type EndpointInfo = {
  signature: string;
  state: "loading" | "ready" | "error";
  adapterIdentity?: string;
  schemas?: SchemaDescriptor[];
  routes?: InternalDescribeResponse["routes"];
  error?: string;
};

type EndpointStatus = {
  lastSyncAt?: number;
  appliedEntries?: number;
  lastVersionstamp?: string;
  error?: string;
};

type TableSelection = {
  endpointId: string;
  schemaName: string;
  tableName: string;
};

type SubmitStatus = {
  lastQueuedAt?: number;
  lastCommandId?: string;
  lastSubmitAt?: number;
  lastSubmitStatus?: "applied" | "conflict" | "error";
  lastSubmitReason?: string;
  lastSubmitError?: string;
};

type OutboxEntryStatus = "applied" | "pending" | "unknown";

type OutboxEntryView = {
  key: string;
  versionstamp: string;
  uowId: string;
  createdAt?: number;
  mutations?: number;
  status: OutboxEntryStatus;
};

type OutboxState = {
  state: "idle" | "loading" | "ready" | "error" | "disabled";
  entries: OutboxEntryView[];
  updatedAt?: number;
  error?: string;
};

type LofiSubmitCommandTarget = {
  fragment: string;
  schema: string;
};

type CommandDefinition = {
  key: string;
  name: string;
  label: string;
  target: LofiSubmitCommandTarget;
  schemaName: string;
  handler: SyncCommandDefinition["handler"];
  defaultInput: Record<string, unknown>;
  description?: string;
};

type AdapterGroup = {
  id: string;
  endpointIds: string[];
  endpointLabels: string[];
  primaryEndpointId: string;
  outboxUrl: string;
  internalUrl: string;
  submitUrl: string;
  endpointName: string;
  schemas: AnySchema[];
  missingSchemas: string[];
  commands: CommandDefinition[];
  enabled: boolean;
  pollIntervalMs: number;
  outboxEnabled: boolean;
};

type AdapterRuntime = {
  signature: string;
  adapterIdentity: string;
  endpointName: string;
  endpointIds: string[];
  adapter: IndexedDbAdapter;
  client: LofiClient;
  submit?: LofiSubmitClient;
  schemas: AnySchema[];
  outboxUrl: string;
  pollIntervalMs: number;
  timer?: ReturnType<typeof setInterval>;
  syncOnce: () => Promise<void>;
  start: () => void;
  stop: () => void;
  dispose: () => void;
};

const SCHEMA_REGISTRY = new Map<string, AnySchema>([
  [commentSchema.name, commentSchema],
  [upvoteSchema.name, upvoteSchema],
]);

const DEFAULT_ENDPOINTS: EndpointConfig[] = [
  {
    id: "comment",
    label: "Comments",
    baseUrl: "http://localhost:3000/api/fragno-db-comment",
    pollIntervalMs: 1000,
    enabled: true,
  },
  {
    id: "rating",
    label: "Ratings",
    baseUrl: "http://localhost:3000/api/fragno-db-rating",
    pollIntervalMs: 1200,
    enabled: true,
  },
];

const commandKey = (target: LofiSubmitCommandTarget, name: string) =>
  `${target.fragment}::${target.schema}::${name}`;

const formatCommandLabel = (name: string) => {
  const withSpaces = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return withSpaces.replace(/\b\w/g, (char) => char.toUpperCase());
};

const buildCommandDefinitions = (
  registry: SyncCommandRegistry,
  target: LofiSubmitCommandTarget,
  templates: Record<
    string,
    { label?: string; defaultInput?: Record<string, unknown>; description?: string }
  >,
): CommandDefinition[] => {
  return Array.from(registry.commands.values()).map((command) => {
    const key = commandKey(target, command.name);
    const template = templates[key];
    return {
      key,
      name: command.name,
      label: template?.label ?? formatCommandLabel(command.name),
      target,
      schemaName: target.schema,
      handler: command.handler,
      defaultInput: template?.defaultInput ?? {},
      description: template?.description,
    };
  });
};

const COMMENT_TARGET: LofiSubmitCommandTarget = {
  fragment: "fragno-db-comment",
  schema: commentSchema.name,
};

const RATING_TARGET: LofiSubmitCommandTarget = {
  fragment: "fragno-db-rating",
  schema: upvoteSchema.name,
};

const COMMAND_TEMPLATES: Record<
  string,
  { label?: string; defaultInput?: Record<string, unknown>; description?: string }
> = {
  [commandKey(COMMENT_TARGET, "createComment")]: {
    label: "Create comment",
    description: "Adds a comment row via the sync command handler.",
    defaultInput: {
      title: "Hello from Lofi",
      content: "This comment was created locally and synced.",
      postReference: "post-1",
      userReference: "user-1",
      parentId: null,
    },
  },
  [commandKey(RATING_TARGET, "postRating")]: {
    label: "Post rating",
    description: "Adds an upvote and adjusts the total.",
    defaultInput: {
      reference: "post-1",
      rating: 1,
      ownerReference: "user-1",
      note: null,
    },
  },
};

const COMMAND_DEFINITIONS: CommandDefinition[] = [
  ...buildCommandDefinitions(commentSyncCommands, COMMENT_TARGET, COMMAND_TEMPLATES),
  ...buildCommandDefinitions(ratingSyncCommands, RATING_TARGET, COMMAND_TEMPLATES),
];

const COMMANDS_BY_SCHEMA = COMMAND_DEFINITIONS.reduce((map, command) => {
  const existing = map.get(command.schemaName);
  if (existing) {
    existing.push(command);
  } else {
    map.set(command.schemaName, [command]);
  }
  return map;
}, new Map<string, CommandDefinition[]>());

export default function App() {
  const [endpoints, setEndpoints] = useStoredState<EndpointConfig[]>(
    "fragno-lofi-endpoints",
    DEFAULT_ENDPOINTS,
  );
  const [activeTab, setActiveTab] = useStoredState<AppTab>("fragno-lofi-tab", "tables");
  const [selectedEndpointId, setSelectedEndpointId] = useState<string>(endpoints[0]?.id ?? "");
  const [endpointInfos, setEndpointInfos] = useState<Record<string, EndpointInfo>>({});
  const [selectedTable, setSelectedTable] = useState<TableSelection | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [tableError, setTableError] = useState<string | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const [statuses, setStatuses] = useState<Record<string, EndpointStatus>>({});
  const [submitStatuses, setSubmitStatuses] = useState<Record<string, SubmitStatus>>({});
  const [tableHighlights, setTableHighlights] = useState<Record<string, number>>({});
  const [newRowSignatures, setNewRowSignatures] = useState<string[]>([]);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [commandForm, setCommandForm] = useState<{
    commandKey: string;
    input: string;
    optimistic: boolean;
  }>({
    commandKey: "",
    input: "",
    optimistic: true,
  });
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);

  const [outboxByGroup, setOutboxByGroup] = useState<Record<string, OutboxState>>({});
  const [outboxRefreshTick, setOutboxRefreshTick] = useState(0);

  const endpointInfoRef = useRef(endpointInfos);
  const runtimesRef = useRef<Map<string, AdapterRuntime>>(new Map());
  const tableCountsRef = useRef<Record<string, number>>({});
  const previousRowSignaturesRef = useRef<Map<string, Set<string>>>(new Map());
  const tableHighlightTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const rowHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    endpointInfoRef.current = endpointInfos;
  }, [endpointInfos]);

  const { groups: adapterGroups, endpointToGroup } = useMemo(
    () => buildAdapterGroups(endpoints, endpointInfos),
    [endpoints, endpointInfos],
  );

  const selectedEndpoint = endpoints.find((endpoint) => endpoint.id === selectedEndpointId);
  const selectedGroup = selectedEndpointId ? endpointToGroup.get(selectedEndpointId) : undefined;
  const adapterGroupOptions = useMemo(
    () =>
      adapterGroups.map((group) => ({
        id: group.id,
        label: formatGroupLabel(group),
        endpointId: group.primaryEndpointId,
      })),
    [adapterGroups],
  );
  const selectedGroupId = selectedGroup?.id ?? adapterGroupOptions[0]?.id ?? "";
  const selectedGroupLabel = selectedGroup ? formatGroupLabel(selectedGroup) : "";
  const selectedTableKey = selectedTable
    ? `${selectedTable.schemaName}.${selectedTable.tableName}`
    : "";
  const selectedEndpointSummary = selectedGroup
    ? `${selectedGroupLabel} · ${selectedEndpoint?.baseUrl ?? selectedGroup.outboxUrl}`
    : "Choose an endpoint from the Endpoints tab.";
  const availableCommands = selectedGroup?.commands ?? [];
  const selectedCommand =
    availableCommands.find((command) => command.key === commandForm.commandKey) ??
    availableCommands[0];
  const selectedSubmitStatus = selectedEndpointId ? submitStatuses[selectedEndpointId] : undefined;
  const selectedOutboxState = selectedGroup ? outboxByGroup[selectedGroup.id] : undefined;
  const outboxEntries = selectedOutboxState?.entries ?? [];

  const triggerTableHighlight = useCallback((tableKey: string) => {
    const existing = tableHighlightTimers.current.get(tableKey);
    if (existing) {
      clearTimeout(existing);
    }
    setTableHighlights((prev) => ({ ...prev, [tableKey]: Date.now() }));
    const timer = setTimeout(() => {
      setTableHighlights((prev) => {
        const next = { ...prev };
        delete next[tableKey];
        return next;
      });
      tableHighlightTimers.current.delete(tableKey);
    }, 2600);
    tableHighlightTimers.current.set(tableKey, timer);
  }, []);

  const triggerRowHighlights = useCallback((signatures: string[]) => {
    if (rowHighlightTimer.current) {
      clearTimeout(rowHighlightTimer.current);
    }
    setNewRowSignatures(signatures);
    if (signatures.length === 0) {
      rowHighlightTimer.current = null;
      return;
    }
    rowHighlightTimer.current = setTimeout(() => {
      setNewRowSignatures([]);
      rowHighlightTimer.current = null;
    }, 2600);
  }, []);

  const updateSubmitStatus = useCallback((endpointIds: string[], patch: SubmitStatus) => {
    setSubmitStatuses((prev) => {
      const next = { ...prev };
      for (const endpointId of endpointIds) {
        next[endpointId] = { ...prev[endpointId], ...patch };
      }
      return next;
    });
  }, []);

  const selectAdapterGroup = useCallback(
    (groupId: string) => {
      const group = adapterGroups.find((entry) => entry.id === groupId);
      if (group?.primaryEndpointId) {
        setSelectedEndpointId(group.primaryEndpointId);
      }
    },
    [adapterGroups],
  );

  useEffect(() => {
    return () => {
      tableHighlightTimers.current.forEach((timer) => clearTimeout(timer));
      tableHighlightTimers.current.clear();
      if (rowHighlightTimer.current) {
        clearTimeout(rowHighlightTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    tableCountsRef.current = {};
    previousRowSignaturesRef.current.clear();
    setTableHighlights({});
    triggerRowHighlights([]);
    tableHighlightTimers.current.forEach((timer) => clearTimeout(timer));
    tableHighlightTimers.current.clear();
  }, [selectedGroup?.id, triggerRowHighlights]);

  useEffect(() => {
    if (!availableCommands.length) {
      setCommandForm((prev) => ({
        ...prev,
        commandKey: "",
        input: "",
      }));
      return;
    }

    if (availableCommands.some((command) => command.key === commandForm.commandKey)) {
      return;
    }

    const defaultCommand = availableCommands[0];
    setCommandForm((prev) => ({
      ...prev,
      commandKey: defaultCommand.key,
      input: stringifyJson(defaultCommand.defaultInput),
    }));
  }, [availableCommands, commandForm.commandKey]);

  const tableOptions = useMemo(() => {
    if (!selectedGroup) {
      return [] as TableSelection[];
    }
    return selectedGroup.schemas.flatMap((schema) =>
      Object.keys(schema.tables).map((tableName) => ({
        endpointId: selectedEndpointId,
        schemaName: schema.name,
        tableName,
      })),
    );
  }, [selectedEndpointId, selectedGroup]);

  const loadOutboxAppliedSet = useCallback(
    async (
      runtime: AdapterRuntime,
      entries: OutboxEntry[],
      signal: AbortSignal,
    ): Promise<Set<string> | null> => {
      if (entries.length === 0) {
        return new Set<string>();
      }

      const schemaName = runtime.schemas[0]?.name;
      if (!schemaName) {
        return null;
      }

      try {
        const ctx = runtime.adapter.createQueryContext(schemaName);
        const db = await ctx.getDb();
        const tx = db.transaction("lofi_inbox", "readonly");
        const store = tx.objectStore("lofi_inbox");
        const sourceKey = `${runtime.endpointName}::outbox`;
        const applied = new Set<string>();

        await Promise.all(
          entries.map(async (entry) => {
            if (signal.aborted) {
              return;
            }
            const row = await store.get([sourceKey, entry.uowId, entry.versionstamp]);
            if (row) {
              applied.add(getOutboxEntryKey(entry));
            }
          }),
        );

        await tx.done;
        return applied;
      } catch (error) {
        if (isDbClosingError(error)) {
          return null;
        }
        return null;
      }
    },
    [],
  );

  const buildOutboxEntries = useCallback(
    async (
      runtime: AdapterRuntime,
      entries: OutboxEntry[],
      signal: AbortSignal,
    ): Promise<OutboxEntryView[]> => {
      const applied = await loadOutboxAppliedSet(runtime, entries, signal);
      return entries.map((entry) => {
        const key = getOutboxEntryKey(entry);
        const status: OutboxEntryStatus = applied
          ? applied.has(key)
            ? "applied"
            : "pending"
          : "unknown";
        return {
          key,
          versionstamp: entry.versionstamp,
          uowId: entry.uowId,
          createdAt: parseOutboxCreatedAt(entry.createdAt),
          mutations: getOutboxMutationCount(entry),
          status,
        };
      });
    },
    [loadOutboxAppliedSet],
  );

  useEffect(() => {
    if (selectedEndpointId && endpoints.some((endpoint) => endpoint.id === selectedEndpointId)) {
      return;
    }
    setSelectedEndpointId(endpoints[0]?.id ?? "");
  }, [endpoints, selectedEndpointId]);

  useEffect(() => {
    if (!selectedTable) {
      return;
    }
    const stillExists = tableOptions.some(
      (option) =>
        option.endpointId === selectedTable.endpointId &&
        option.schemaName === selectedTable.schemaName &&
        option.tableName === selectedTable.tableName,
    );
    if (!stillExists) {
      setSelectedTable(null);
    }
  }, [tableOptions, selectedTable]);

  useEffect(() => {
    triggerRowHighlights([]);
    setExpandedRows({});
  }, [selectedTableKey, triggerRowHighlights]);

  useEffect(() => {
    let cancelled = false;
    const controllers = new Map<string, AbortController>();

    setEndpointInfos((prev) => {
      const next: Record<string, EndpointInfo> = {};
      for (const endpoint of endpoints) {
        if (prev[endpoint.id]) {
          next[endpoint.id] = prev[endpoint.id];
        }
      }
      return next;
    });

    const fetchDescribe = async (endpoint: EndpointConfig, signal: AbortSignal) => {
      const signature = endpoint.baseUrl.trim();
      const existing = endpointInfoRef.current[endpoint.id];

      if (existing?.signature === signature && existing.state === "ready") {
        return;
      }

      setEndpointInfos((prev) => ({
        ...prev,
        [endpoint.id]: {
          signature,
          state: "loading",
          adapterIdentity: existing?.adapterIdentity,
          schemas: existing?.schemas,
          routes: existing?.routes,
        },
      }));

      try {
        const response = await fetch(buildInternalDescribeUrl(endpoint.baseUrl), { signal });
        const data = (await response.json()) as InternalDescribeResponse | InternalDescribeError;

        if (signal.aborted || cancelled) {
          return;
        }

        if (!response.ok) {
          setEndpointInfos((prev) => ({
            ...prev,
            [endpoint.id]: {
              signature,
              state: "error",
              error: `Describe failed: ${response.status} ${response.statusText}`,
            },
          }));
          return;
        }

        if (data && typeof data === "object" && "error" in data) {
          setEndpointInfos((prev) => ({
            ...prev,
            [endpoint.id]: {
              signature,
              state: "error",
              error: data.error.detail
                ? `${data.error.message} (${data.error.detail})`
                : data.error.message,
            },
          }));
          return;
        }

        const adapterIdentity = data.adapterIdentity ?? signature;

        setEndpointInfos((prev) => ({
          ...prev,
          [endpoint.id]: {
            signature,
            state: "ready",
            adapterIdentity,
            schemas: data.schemas ?? [],
            routes: data.routes,
          },
        }));
      } catch (error) {
        if (signal.aborted || cancelled) {
          return;
        }
        setEndpointInfos((prev) => ({
          ...prev,
          [endpoint.id]: {
            signature,
            state: "error",
            error: formatError(error),
          },
        }));
      }
    };

    for (const endpoint of endpoints) {
      const controller = new AbortController();
      controllers.set(endpoint.id, controller);
      void fetchDescribe(endpoint, controller.signal);
    }

    return () => {
      cancelled = true;
      controllers.forEach((controller) => controller.abort());
    };
  }, [endpoints]);

  useEffect(() => {
    const runtimes = runtimesRef.current;
    const activeIds = new Set(adapterGroups.map((group) => group.id));

    for (const group of adapterGroups) {
      const schemaSignature = group.schemas
        .map((schema) => schema.name)
        .sort()
        .join(",");
      const endpointSignature = group.endpointIds.slice().sort().join(",");
      const signature = `${group.outboxUrl}::${group.pollIntervalMs}::${schemaSignature}::${endpointSignature}`;
      const existing = runtimes.get(group.id);

      if (!existing || existing.signature !== signature) {
        existing?.dispose();
        const runtime = createRuntime(
          group,
          signature,
          (status) => {
            setStatuses((prev) => {
              const next = { ...prev };
              for (const endpointId of group.endpointIds) {
                next[endpointId] = {
                  ...prev[endpointId],
                  ...status,
                };
              }
              return next;
            });
          },
          () => setSyncTick((prev) => prev + 1),
        );
        runtimes.set(group.id, runtime);
      }

      const runtime = runtimes.get(group.id);
      if (!runtime) {
        continue;
      }

      if (group.enabled) {
        runtime.start();
      } else {
        runtime.stop();
      }
    }

    for (const [id, runtime] of runtimes) {
      if (!activeIds.has(id)) {
        runtime.dispose();
        runtimes.delete(id);
      }
    }
  }, [adapterGroups]);

  useEffect(() => {
    return () => {
      for (const runtime of runtimesRef.current.values()) {
        runtime.dispose();
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedGroup) {
      return;
    }
    const runtime = runtimesRef.current.get(selectedGroup.id);
    if (!runtime) {
      return;
    }

    let cancelled = false;

    const refreshCounts = async () => {
      try {
        const nextCounts: Record<string, number> = {};
        for (const schema of selectedGroup.schemas) {
          const query = runtime.adapter.createQueryEngine(schema);
          for (const tableName of Object.keys(schema.tables)) {
            const data = await query.find(tableName as never);
            nextCounts[`${schema.name}.${tableName}`] = data.length;
          }
        }

        if (cancelled) {
          return;
        }

        const prevCounts = tableCountsRef.current;
        const hasPrev = Object.keys(prevCounts).length > 0;
        tableCountsRef.current = nextCounts;

        if (!hasPrev) {
          return;
        }

        for (const [key, count] of Object.entries(nextCounts)) {
          const prevCount = prevCounts[key] ?? 0;
          if (count > prevCount) {
            triggerTableHighlight(key);
          }
        }
      } catch (error) {
        if (isDbClosingError(error)) {
          // Swallow transient IndexedDB closing errors; next tick will retry.
          return;
        }
      }
    };

    void refreshCounts();

    return () => {
      cancelled = true;
    };
  }, [selectedGroup, syncTick, triggerTableHighlight]);

  useEffect(() => {
    let cancelled = false;

    const loadRows = async () => {
      if (!selectedTable) {
        setRows([]);
        setTableError(null);
        triggerRowHighlights([]);
        return;
      }

      const group = endpointToGroup.get(selectedTable.endpointId);
      if (!group) {
        setRows([]);
        setTableError("Endpoint not initialized yet.");
        triggerRowHighlights([]);
        return;
      }

      const runtime = runtimesRef.current.get(group.id);
      if (!runtime) {
        setRows([]);
        setTableError("Endpoint not initialized yet.");
        triggerRowHighlights([]);
        return;
      }

      const schema = runtime.schemas.find((s) => s.name === selectedTable.schemaName);
      if (!schema) {
        setRows([]);
        setTableError("Schema not available for this endpoint.");
        triggerRowHighlights([]);
        return;
      }

      setTableLoading(true);
      setTableError(null);
      try {
        const query = runtime.adapter.createQueryEngine(schema);
        const data = await query.find(selectedTable.tableName as never);
        if (cancelled) {
          return;
        }
        const rowsData = data as Record<string, unknown>[];
        const tableKey = `${selectedTable.schemaName}.${selectedTable.tableName}`;
        const signatures = rowsData.map((row) => getRowSignature(row));
        const nextSet = new Set(signatures);
        const prevSet = previousRowSignaturesRef.current.get(tableKey);
        const hadPrev = Boolean(prevSet);
        previousRowSignaturesRef.current.set(tableKey, nextSet);
        if (hadPrev && prevSet) {
          const newOnes = signatures.filter((sig) => !prevSet.has(sig));
          if (newOnes.length > 0) {
            triggerRowHighlights(newOnes);
            triggerTableHighlight(tableKey);
          } else {
            triggerRowHighlights([]);
          }
        }
        setRows(rowsData);
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (isDbClosingError(error)) {
          setTableError(null);
          setTimeout(() => {
            if (!cancelled) {
              void loadRows();
            }
          }, 180);
          return;
        }
        setTableError(formatError(error));
        setRows([]);
      } finally {
        if (!cancelled) {
          setTableLoading(false);
        }
      }
    };

    void loadRows();

    return () => {
      cancelled = true;
    };
  }, [endpointToGroup, selectedTable, syncTick, triggerRowHighlights, triggerTableHighlight]);

  useEffect(() => {
    if (!selectedGroup) {
      return;
    }

    if (!selectedGroup.outboxEnabled) {
      setOutboxByGroup((prev) => ({
        ...prev,
        [selectedGroup.id]: {
          state: "disabled",
          entries: [],
        },
      }));
      return;
    }

    const runtime = runtimesRef.current.get(selectedGroup.id);
    if (!runtime) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const loadOutbox = async () => {
      setOutboxByGroup((prev) => ({
        ...prev,
        [selectedGroup.id]: {
          ...(prev[selectedGroup.id] ?? { entries: [] }),
          state: "loading",
          error: undefined,
        },
      }));

      try {
        const response = await fetch(selectedGroup.outboxUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Outbox request failed: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as OutboxEntry[];
        if (!Array.isArray(data)) {
          throw new Error("Invalid outbox response payload");
        }

        if (controller.signal.aborted || cancelled) {
          return;
        }

        const entries = await buildOutboxEntries(runtime, data, controller.signal);

        if (controller.signal.aborted || cancelled) {
          return;
        }

        setOutboxByGroup((prev) => ({
          ...prev,
          [selectedGroup.id]: {
            state: "ready",
            entries,
            updatedAt: Date.now(),
            error: undefined,
          },
        }));
      } catch (error) {
        if (controller.signal.aborted || cancelled) {
          return;
        }
        setOutboxByGroup((prev) => ({
          ...prev,
          [selectedGroup.id]: {
            state: "error",
            entries: prev[selectedGroup.id]?.entries ?? [],
            error: formatError(error),
          },
        }));
      }
    };

    void loadOutbox();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    buildOutboxEntries,
    outboxRefreshTick,
    selectedGroup?.id,
    selectedGroup?.outboxEnabled,
    selectedGroup?.outboxUrl,
    syncTick,
  ]);

  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach((key) => keys.add(key));
    }
    const ordered = Array.from(keys);
    ordered.sort((a, b) => {
      if (a === "id") {
        return -1;
      }
      if (b === "id") {
        return 1;
      }
      return a.localeCompare(b);
    });
    return ordered;
  }, [rows]);

  const addEndpoint = () => {
    const id = crypto.randomUUID();
    setEndpoints((prev) => [
      ...prev,
      {
        id,
        label: "New endpoint",
        baseUrl: "http://localhost:3000/api/fragno-db-comment",
        pollIntervalMs: 1000,
        enabled: true,
      },
    ]);
    setSelectedEndpointId(id);
  };

  const updateEndpoint = (id: string, patch: Partial<EndpointConfig>) => {
    setEndpoints((prev) =>
      prev.map((endpoint) => (endpoint.id === id ? { ...endpoint, ...patch } : endpoint)),
    );
  };

  const removeEndpoint = (id: string) => {
    setEndpoints((prev) => prev.filter((endpoint) => endpoint.id !== id));
  };

  const syncEndpoint = async (id: string) => {
    const group = endpointToGroup.get(id);
    if (!group) {
      return;
    }
    const runtime = runtimesRef.current.get(group.id);
    if (!runtime) {
      return;
    }
    await runtime.syncOnce();
  };

  const toggleRowExpanded = useCallback((signature: string) => {
    setExpandedRows((prev) => ({
      ...prev,
      [signature]: !prev[signature],
    }));
  }, []);

  const queueCommand = async (shouldSubmit: boolean) => {
    if (!selectedGroup) {
      setCommandError("Select an endpoint before sending commands.");
      return;
    }

    const runtime = runtimesRef.current.get(selectedGroup.id);
    if (!runtime?.submit) {
      setCommandError("Sync commands are not available for this endpoint.");
      return;
    }

    if (!selectedCommand) {
      setCommandError("Choose a sync command to run.");
      return;
    }

    const trimmed = commandForm.input.trim();
    let inputPayload: unknown = {};
    if (trimmed.length > 0) {
      try {
        inputPayload = JSON.parse(trimmed);
      } catch (error) {
        setCommandError(`Invalid JSON: ${formatError(error)}`);
        return;
      }
    }

    setCommandError(null);
    setCommandBusy(true);

    try {
      const commandId = await runtime.submit.queueCommand({
        name: selectedCommand.name,
        target: selectedCommand.target,
        input: inputPayload,
        optimistic: commandForm.optimistic,
      });

      updateSubmitStatus(selectedGroup.endpointIds, {
        lastQueuedAt: Date.now(),
        lastCommandId: commandId,
      });

      if (shouldSubmit) {
        const response = await runtime.submit.submitOnce();
        if (response.entries.length > 0) {
          setSyncTick((prev) => prev + 1);
        }
        updateSubmitStatus(selectedGroup.endpointIds, {
          lastSubmitAt: Date.now(),
          lastSubmitStatus: response.status,
          lastSubmitReason: response.status === "conflict" ? response.reason : undefined,
          lastSubmitError: undefined,
        });
      }
    } catch (error) {
      updateSubmitStatus(selectedGroup.endpointIds, {
        lastSubmitAt: Date.now(),
        lastSubmitStatus: "error",
        lastSubmitError: formatError(error),
      });
      setCommandError(formatError(error));
    } finally {
      setCommandBusy(false);
    }
  };

  const submitPendingCommands = async () => {
    if (!selectedGroup) {
      setCommandError("Select an endpoint before submitting commands.");
      return;
    }

    const runtime = runtimesRef.current.get(selectedGroup.id);
    if (!runtime?.submit) {
      setCommandError("Sync commands are not available for this endpoint.");
      return;
    }

    setCommandError(null);
    setCommandBusy(true);
    try {
      const response = await runtime.submit.submitOnce();
      if (response.entries.length > 0) {
        setSyncTick((prev) => prev + 1);
      }
      updateSubmitStatus(selectedGroup.endpointIds, {
        lastSubmitAt: Date.now(),
        lastSubmitStatus: response.status,
        lastSubmitReason: response.status === "conflict" ? response.reason : undefined,
        lastSubmitError: undefined,
      });
    } catch (error) {
      updateSubmitStatus(selectedGroup.endpointIds, {
        lastSubmitAt: Date.now(),
        lastSubmitStatus: "error",
        lastSubmitError: formatError(error),
      });
      setCommandError(formatError(error));
    } finally {
      setCommandBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Fragno Lofi</p>
          <h1>Local-first outbox explorer</h1>
          <p className="subtitle">
            Connect to outbox endpoints, keep syncing in the background, and browse the local
            IndexedDB mirror.
          </p>
        </div>
        <div className="hero-card">
          <div className="hero-metric">
            <span>Active endpoints</span>
            <strong>{adapterGroups.filter((group) => group.enabled).length}</strong>
          </div>
          <div className="hero-metric">
            <span>Tables visible</span>
            <strong>{tableOptions.length}</strong>
          </div>
        </div>
      </header>
      <div className="tabs">
        <button
          className={`tab ${activeTab === "tables" ? "tab--active" : ""}`}
          onClick={() => setActiveTab("tables")}
          type="button"
        >
          Tables
        </button>
        <button
          className={`tab ${activeTab === "endpoints" ? "tab--active" : ""}`}
          onClick={() => setActiveTab("endpoints")}
          type="button"
        >
          Endpoints
        </button>
        <button
          className={`tab ${activeTab === "commands" ? "tab--active" : ""}`}
          onClick={() => setActiveTab("commands")}
          type="button"
        >
          Commands
        </button>
      </div>

      {activeTab === "tables" ? (
        <main className="layout layout--tables">
          <section className="panel tables">
            <div className="panel-title">
              <div>
                <h2>Tables</h2>
                <p className="panel-subtitle">{selectedEndpointSummary}</p>
              </div>
              <button
                className="btn btn--ghost"
                onClick={() => setActiveTab("endpoints")}
                type="button"
              >
                Manage endpoints
              </button>
            </div>
            <div className="panel-body table-list">
              {tableOptions.map((table) => {
                const active =
                  selectedTable?.endpointId === table.endpointId &&
                  selectedTable?.schemaName === table.schemaName &&
                  selectedTable?.tableName === table.tableName;
                const tableKey = `${table.schemaName}.${table.tableName}`;
                const isHot = Boolean(tableHighlights[tableKey]);
                return (
                  <button
                    className={`table-item${active ? "table-item--active" : ""}${
                      isHot ? "table-item--hot" : ""
                    }`}
                    key={tableKey}
                    onClick={() => setSelectedTable(table)}
                    type="button"
                  >
                    <span className="mono">
                      {table.schemaName}.{table.tableName}
                    </span>
                    {isHot ? <span className="table-item__pulse">New</span> : null}
                  </button>
                );
              })}
              {!tableOptions.length ? (
                <div className="empty">No tables available for this endpoint.</div>
              ) : null}
              {selectedGroup?.missingSchemas.length ? (
                <div className="muted">
                  Missing local schemas: {selectedGroup.missingSchemas.join(", ")}
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel rows-panel">
            <div className="panel-title">
              <div>
                <h2>Rows</h2>
                <p className="panel-subtitle">
                  {selectedTable ? (
                    <span className="mono">
                      {selectedTable.schemaName}.{selectedTable.tableName}
                    </span>
                  ) : (
                    <span>Select a table to inspect</span>
                  )}
                </p>
              </div>
              {selectedTable ? <span className="chip">{rows.length} rows</span> : null}
            </div>

            <div className="panel-body">
              {tableError ? <div className="status-error">{tableError}</div> : null}
              {tableLoading ? <div className="loading">Loading rows...</div> : null}

              {!tableLoading && !rows.length ? (
                <div className="empty">
                  No rows yet. Create data via fragno-db-usage-drizzle and keep syncing.
                </div>
              ) : null}

              {rows.length ? (
                <div className="db-table-wrap">
                  <table className="db-table">
                    <thead>
                      <tr>
                        <th className="db-head db-head--toggle" />
                        <th className="db-head db-head--index">#</th>
                        {columns.map((column) => (
                          <th className="db-head" key={column}>
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, rowIndex) => {
                        const signature = getRowSignature(row);
                        const isNew = newRowSignatures.includes(signature);
                        const entries = orderRowEntries(row);
                        const expanded = Boolean(expandedRows[signature]);
                        return (
                          <Fragment key={signature || rowIndex}>
                            <tr className={`db-row${isNew ? "db-row--new" : ""}`}>
                              <td className="db-cell db-cell--toggle">
                                <button
                                  className="db-toggle"
                                  type="button"
                                  onClick={() => toggleRowExpanded(signature)}
                                  aria-expanded={expanded}
                                  aria-label={expanded ? "Collapse row" : "Expand row"}
                                >
                                  {expanded ? "▾" : "▸"}
                                </button>
                              </td>
                              <td className="db-cell db-cell--index">{rowIndex + 1}</td>
                              {columns.map((column) => (
                                <td
                                  className={`db-cell${column === "id" ? "db-cell--id" : ""}`}
                                  key={column}
                                  title={formatInlineValue(row[column])}
                                >
                                  {renderInlineCell(column, row[column])}
                                </td>
                              ))}
                            </tr>
                            {expanded ? (
                              <tr className="db-row-detail">
                                <td colSpan={columns.length + 2}>
                                  <div className="row-details">
                                    <div className="row-grid">
                                      {entries.map(([key, value]) => {
                                        const jsonLike = isJsonValue(value) && key !== "id";
                                        return (
                                          <div
                                            className={`row-field${jsonLike ? "row-field--wide" : ""}`}
                                            key={key}
                                          >
                                            <div className="row-label">{key}</div>
                                            <div className="row-value">
                                              {renderValue(key, value)}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel panel--wide">
            <div className="panel-title">
              <div>
                <h2>Sync commands</h2>
                <p className="panel-subtitle">{selectedEndpointSummary}</p>
              </div>
              <button
                className="btn btn--ghost"
                onClick={() => setActiveTab("endpoints")}
                type="button"
              >
                Manage endpoints
              </button>
            </div>
            <div className="panel-body command-form">
              <label>
                Endpoint
                <select
                  className="input"
                  value={selectedGroupId}
                  onChange={(event) => selectAdapterGroup(event.target.value)}
                  disabled={!adapterGroupOptions.length}
                >
                  {adapterGroupOptions.length ? null : <option value="">No endpoints</option>}
                  {adapterGroupOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Command
                <select
                  className="input"
                  value={selectedCommand?.key ?? ""}
                  onChange={(event) => {
                    const nextKey = event.target.value;
                    const command = availableCommands.find((entry) => entry.key === nextKey);
                    setCommandForm((prev) => ({
                      ...prev,
                      commandKey: nextKey,
                      input: command ? stringifyJson(command.defaultInput) : prev.input,
                    }));
                    setCommandError(null);
                  }}
                  disabled={!availableCommands.length}
                >
                  {availableCommands.length ? null : <option value="">No commands</option>}
                  {availableCommands.map((command) => (
                    <option key={command.key} value={command.key}>
                      {command.label}
                    </option>
                  ))}
                </select>
              </label>
              {selectedCommand?.description ? (
                <p className="muted">{selectedCommand.description}</p>
              ) : null}
              <label>
                Input (JSON)
                <textarea
                  className="textarea"
                  rows={8}
                  value={commandForm.input}
                  onChange={(event) => {
                    setCommandForm((prev) => ({ ...prev, input: event.target.value }));
                    setCommandError(null);
                  }}
                  placeholder='{"example": true}'
                  disabled={!selectedCommand}
                />
              </label>
              <div className="command-actions">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={commandForm.optimistic}
                    onChange={(event) =>
                      setCommandForm((prev) => ({
                        ...prev,
                        optimistic: event.target.checked,
                      }))
                    }
                  />
                  <span>Optimistic apply</span>
                </label>
                <button
                  className="btn"
                  type="button"
                  onClick={() => void queueCommand(false)}
                  disabled={!selectedCommand || commandBusy}
                >
                  Queue command
                </button>
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={() => void queueCommand(true)}
                  disabled={!selectedCommand || commandBusy}
                >
                  Queue + submit
                </button>
              </div>
              {commandError ? <div className="status-error">{commandError}</div> : null}
            </div>
          </section>
        </main>
      ) : activeTab === "endpoints" ? (
        <main className="layout layout--endpoints">
          <section className="panel endpoints">
            <div className="panel-title">
              <h2>Endpoints</h2>
              <button className="btn" onClick={addEndpoint} type="button">
                Add endpoint
              </button>
            </div>
            <div className="panel-body endpoint-list">
              {endpoints.map((endpoint) => {
                const status = statuses[endpoint.id];
                const info = endpointInfos[endpoint.id];
                const adapterLabel = info?.adapterIdentity
                  ? info.adapterIdentity.slice(0, 12)
                  : info?.state === "loading"
                    ? "Loading..."
                    : "-";
                const schemaLabel = info?.schemas?.length
                  ? info.schemas.map((schema) => schema.name).join(", ")
                  : info?.state === "loading"
                    ? "Loading..."
                    : "-";

                return (
                  <article
                    className={`endpoint-card${
                      endpoint.id === selectedEndpointId ? "endpoint-card--active" : ""
                    }`}
                    key={endpoint.id}
                  >
                    <div className="endpoint-head">
                      <div>
                        <input
                          className="input input--title"
                          value={endpoint.label}
                          onChange={(event) =>
                            updateEndpoint(endpoint.id, { label: event.target.value })
                          }
                        />
                        <p className="muted">{endpoint.baseUrl}</p>
                      </div>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={endpoint.enabled}
                          onChange={(event) =>
                            updateEndpoint(endpoint.id, { enabled: event.target.checked })
                          }
                        />
                        <span>Sync</span>
                      </label>
                    </div>

                    <div className="endpoint-fields">
                      <label>
                        Base URL
                        <input
                          className="input"
                          value={endpoint.baseUrl}
                          onChange={(event) =>
                            updateEndpoint(endpoint.id, { baseUrl: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Poll interval (ms)
                        <input
                          className="input"
                          type="number"
                          min={250}
                          value={endpoint.pollIntervalMs}
                          onChange={(event) =>
                            updateEndpoint(endpoint.id, {
                              pollIntervalMs: Math.max(250, Number(event.target.value) || 250),
                            })
                          }
                        />
                      </label>
                      <label>
                        Adapter identity
                        <input className="input" value={adapterLabel} readOnly />
                      </label>
                      <label>
                        Schemas
                        <input className="input" value={schemaLabel} readOnly />
                      </label>
                    </div>

                    <div className="endpoint-status">
                      <div>
                        <span className="chip">Last sync</span>
                        <span>{status?.lastSyncAt ? formatTime(status.lastSyncAt) : "-"}</span>
                      </div>
                      <div>
                        <span className="chip">Applied</span>
                        <span>{status?.appliedEntries ?? 0}</span>
                      </div>
                      <div>
                        <span className="chip">Versionstamp</span>
                        <span className="mono">
                          {status?.lastVersionstamp?.slice(0, 12) ?? "-"}
                        </span>
                      </div>
                      {info?.error ? <div className="status-error">{info.error}</div> : null}
                      {status?.error ? <div className="status-error">{status.error}</div> : null}
                    </div>

                    <div className="endpoint-actions">
                      <button
                        className="btn btn--ghost"
                        onClick={() => {
                          setSelectedEndpointId(endpoint.id);
                          setActiveTab("tables");
                        }}
                        type="button"
                      >
                        Browse tables
                      </button>
                      <button
                        className="btn btn--ghost"
                        onClick={() => void syncEndpoint(endpoint.id)}
                        type="button"
                      >
                        Sync now
                      </button>
                      <button
                        className="btn btn--danger"
                        onClick={() => removeEndpoint(endpoint.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </main>
      ) : (
        <main className="layout layout--commands">
          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Outbox</h2>
                <p className="panel-subtitle">{selectedEndpointSummary}</p>
              </div>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => setOutboxRefreshTick((prev) => prev + 1)}
                disabled={!selectedGroup?.outboxEnabled}
              >
                Refresh
              </button>
            </div>
            <div className="panel-body">
              <div className="outbox-controls">
                <label>
                  Endpoint
                  <select
                    className="input"
                    value={selectedGroupId}
                    onChange={(event) => selectAdapterGroup(event.target.value)}
                    disabled={!adapterGroupOptions.length}
                  >
                    {adapterGroupOptions.length ? null : <option value="">No endpoints</option>}
                    {adapterGroupOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedOutboxState?.updatedAt ? (
                  <div className="muted">
                    Updated {formatTimestamp(selectedOutboxState.updatedAt)}
                  </div>
                ) : null}
              </div>
              {!adapterGroupOptions.length ? (
                <div className="empty">No endpoints configured yet.</div>
              ) : null}
              {selectedOutboxState?.state === "loading" ? (
                <div className="loading">Loading outbox...</div>
              ) : null}
              {selectedOutboxState?.state === "error" ? (
                <div className="status-error">{selectedOutboxState.error}</div>
              ) : null}
              {selectedOutboxState?.state === "disabled" ? (
                <div className="empty">Outbox is not enabled for this endpoint.</div>
              ) : null}
              {selectedOutboxState?.state !== "disabled" && outboxEntries.length ? (
                <div className="table-scroll">
                  <table className="data-table outbox-table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Versionstamp</th>
                        <th>UOW</th>
                        <th>Mutations</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outboxEntries.map((entry) => (
                        <tr key={entry.key}>
                          <td>
                            <span className={`status-badge status-badge--${entry.status}`}>
                              {formatOutboxStatus(entry.status)}
                            </span>
                          </td>
                          <td className="mono" title={entry.versionstamp}>
                            {entry.versionstamp.slice(0, 12)}
                          </td>
                          <td className="mono" title={entry.uowId}>
                            {entry.uowId.slice(0, 12)}
                          </td>
                          <td>{entry.mutations ?? "-"}</td>
                          <td>{formatTimestamp(entry.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {selectedOutboxState?.state === "ready" && !outboxEntries.length ? (
                <div className="empty">Outbox is empty.</div>
              ) : null}
            </div>
          </section>
          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Submit status</h2>
                <p className="panel-subtitle">{selectedEndpointSummary}</p>
              </div>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => void submitPendingCommands()}
                disabled={!selectedGroup?.commands.length || commandBusy}
              >
                Submit pending
              </button>
            </div>
            <div className="panel-body command-status">
              <div>
                <span className="chip">Last queued</span>
                <span>
                  {selectedSubmitStatus?.lastQueuedAt
                    ? formatTime(selectedSubmitStatus.lastQueuedAt)
                    : "-"}
                </span>
              </div>
              <div>
                <span className="chip">Last command</span>
                <span className="mono">
                  {selectedSubmitStatus?.lastCommandId?.slice(0, 12) ?? "-"}
                </span>
              </div>
              <div>
                <span className="chip">Last submit</span>
                <span>
                  {selectedSubmitStatus?.lastSubmitAt
                    ? formatTime(selectedSubmitStatus.lastSubmitAt)
                    : "-"}
                </span>
              </div>
              <div>
                <span className="chip">Status</span>
                <span>
                  {selectedSubmitStatus?.lastSubmitStatus
                    ? selectedSubmitStatus.lastSubmitStatus
                    : "-"}
                </span>
              </div>
              {selectedSubmitStatus?.lastSubmitReason ? (
                <div className="muted">Reason: {selectedSubmitStatus.lastSubmitReason}</div>
              ) : null}
              {selectedSubmitStatus?.lastSubmitError ? (
                <div className="status-error">{selectedSubmitStatus.lastSubmitError}</div>
              ) : null}
              {!selectedGroup?.commands.length ? (
                <div className="empty">No sync commands registered for this endpoint.</div>
              ) : null}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

function createRuntime(
  group: AdapterGroup,
  signature: string,
  onStatus: (status: EndpointStatus) => void,
  onDataChange: () => void,
): AdapterRuntime {
  const adapter = new IndexedDbAdapter({
    endpointName: group.endpointName,
    schemas: group.schemas.map((schema) => ({ schema })),
    ignoreUnknownSchemas: true,
  });

  const client = new LofiClient({
    outboxUrl: group.outboxUrl,
    endpointName: group.endpointName,
    adapter,
    pollIntervalMs: group.pollIntervalMs,
    onError: (error) => {
      onStatus({
        lastSyncAt: Date.now(),
        error: formatError(error),
      });
    },
  });

  const submit =
    group.commands.length > 0
      ? new LofiSubmitClient({
          endpointName: group.endpointName,
          submitUrl: group.submitUrl,
          internalUrl: group.internalUrl,
          adapter,
          schemas: group.schemas,
          commands: group.commands.map((command) => ({
            name: command.name,
            target: command.target,
            handler: command.handler,
          })),
        })
      : undefined;

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const syncOnce = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const result = await client.syncOnce();
      onStatus({
        lastSyncAt: Date.now(),
        appliedEntries: result.appliedEntries,
        lastVersionstamp: result.lastVersionstamp,
        error: undefined,
      });
      if (result.appliedEntries > 0) {
        onDataChange();
      }
    } catch (error) {
      onStatus({
        lastSyncAt: Date.now(),
        error: formatError(error),
      });
    } finally {
      inFlight = false;
    }
  };

  const start = () => {
    if (timer) {
      return;
    }
    void syncOnce();
    timer = setInterval(() => {
      void syncOnce();
    }, group.pollIntervalMs);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const dispose = () => {
    stop();
  };

  return {
    signature,
    adapterIdentity: group.id,
    endpointName: group.endpointName,
    endpointIds: group.endpointIds,
    adapter,
    client,
    submit,
    schemas: group.schemas,
    outboxUrl: group.outboxUrl,
    pollIntervalMs: group.pollIntervalMs,
    timer,
    syncOnce,
    start,
    stop,
    dispose,
  };
}

function buildAdapterGroups(
  endpoints: EndpointConfig[],
  endpointInfos: Record<string, EndpointInfo>,
): { groups: AdapterGroup[]; endpointToGroup: Map<string, AdapterGroup> } {
  const groups = new Map<
    string,
    {
      id: string;
      endpointIds: string[];
      endpointLabels: string[];
      outboxUrl?: string;
      schemaNames: Set<string>;
      missingSchemas: Set<string>;
      outboxEnabled: boolean;
    }
  >();

  for (const endpoint of endpoints) {
    const info = endpointInfos[endpoint.id];
    const adapterIdentity = info?.adapterIdentity ?? `endpoint:${endpoint.id}`;
    let group = groups.get(adapterIdentity);
    if (!group) {
      group = {
        id: adapterIdentity,
        endpointIds: [],
        endpointLabels: [],
        outboxUrl: undefined,
        schemaNames: new Set(),
        missingSchemas: new Set(),
        outboxEnabled: false,
      };
      groups.set(adapterIdentity, group);
    }

    group.endpointIds.push(endpoint.id);
    group.endpointLabels.push(endpoint.label);
    if (!group.outboxUrl) {
      group.outboxUrl = buildOutboxUrl(endpoint.baseUrl);
    }
    if (info?.routes?.outbox) {
      group.outboxEnabled = true;
    }

    const schemaNames = info?.schemas?.length
      ? info.schemas.map((schema) => schema.name)
      : Array.from(SCHEMA_REGISTRY.keys());

    for (const name of schemaNames) {
      if (SCHEMA_REGISTRY.has(name)) {
        group.schemaNames.add(name);
      } else {
        group.missingSchemas.add(name);
      }
    }
  }

  const result: AdapterGroup[] = [];
  const endpointToGroup = new Map<string, AdapterGroup>();

  for (const group of groups.values()) {
    const endpointsInGroup = endpoints.filter((endpoint) =>
      group.endpointIds.includes(endpoint.id),
    );
    const enabledEndpoints = endpointsInGroup.filter((endpoint) => endpoint.enabled);
    const intervalSource = enabledEndpoints.length > 0 ? enabledEndpoints : endpointsInGroup;
    const pollIntervalMs = Math.min(...intervalSource.map((endpoint) => endpoint.pollIntervalMs));
    const enabled = enabledEndpoints.length > 0;
    const schemas = Array.from(group.schemaNames).map((name) => SCHEMA_REGISTRY.get(name)!);
    const commands = schemas.flatMap((schema) => COMMANDS_BY_SCHEMA.get(schema.name) ?? []);
    const baseUrl = endpointsInGroup[0]?.baseUrl ?? "/";
    const endpointName = normalizeEndpointName(`adapter-${group.id}`);
    const outboxUrl = group.outboxUrl ?? buildOutboxUrl(baseUrl);
    const internalUrl = buildInternalDescribeUrl(baseUrl);
    const submitUrl = buildInternalSyncUrl(baseUrl);
    const primaryEndpointId = group.endpointIds[0] ?? "";
    const adapterGroup: AdapterGroup = {
      id: group.id,
      endpointIds: group.endpointIds,
      endpointLabels: group.endpointLabels,
      primaryEndpointId,
      outboxUrl,
      internalUrl,
      submitUrl,
      endpointName,
      schemas,
      missingSchemas: Array.from(group.missingSchemas),
      commands,
      enabled,
      pollIntervalMs,
      outboxEnabled: group.outboxEnabled,
    };

    result.push(adapterGroup);
    for (const endpointId of group.endpointIds) {
      endpointToGroup.set(endpointId, adapterGroup);
    }
  }

  return { groups: result, endpointToGroup };
}

function formatGroupLabel(group: AdapterGroup): string {
  if (!group.endpointLabels.length) {
    return "Endpoint";
  }
  if (group.endpointLabels.length === 1) {
    return group.endpointLabels[0];
  }
  return `${group.endpointLabels[0]} +${group.endpointLabels.length - 1}`;
}

function useStoredState<T>(key: string, initialValue: T) {
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }
    const stored = window.localStorage.getItem(key);
    if (!stored) {
      return initialValue;
    }
    try {
      return JSON.parse(stored) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);

  return [state, setState] as const;
}

function buildInternalDescribeUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.pathname.endsWith("/_internal/outbox")) {
    url.pathname = url.pathname.replace(/\/_internal\/outbox$/, "/_internal");
    return url.toString();
  }
  if (url.pathname.endsWith("/_internal")) {
    return url.toString();
  }
  const trimmed = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${trimmed}/_internal`;
  return url.toString();
}

function buildInternalSyncUrl(baseUrl: string): string {
  const internalUrl = new URL(buildInternalDescribeUrl(baseUrl));
  if (internalUrl.pathname.endsWith("/_internal")) {
    internalUrl.pathname = `${internalUrl.pathname}/sync`;
    return internalUrl.toString();
  }
  const trimmed = internalUrl.pathname.endsWith("/")
    ? internalUrl.pathname.slice(0, -1)
    : internalUrl.pathname;
  internalUrl.pathname = `${trimmed}/sync`;
  return internalUrl.toString();
}

function buildOutboxUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.pathname.endsWith("/_internal/outbox")) {
    return url.toString();
  }
  if (url.pathname.endsWith("/_internal")) {
    url.pathname = `${url.pathname}/outbox`;
    return url.toString();
  }
  const trimmed = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${trimmed}/_internal/outbox`;
  return url.toString();
}

function normalizeEndpointName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "lofi-endpoint";
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

function formatTimestamp(timestamp?: number) {
  if (!timestamp) {
    return "-";
  }
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function formatOutboxStatus(status: OutboxEntryStatus): string {
  if (status === "applied") {
    return "Applied";
  }
  if (status === "pending") {
    return "Pending";
  }
  return "Unknown";
}

function getOutboxEntryKey(entry: Pick<OutboxEntry, "uowId" | "versionstamp">): string {
  return `${entry.uowId}:${entry.versionstamp}`;
}

function parseOutboxCreatedAt(value: OutboxEntry["createdAt"]): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    const time = date.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

function getOutboxMutationCount(entry: OutboxEntry): number | undefined {
  try {
    return decodeOutboxPayload(entry.payload).mutations.length;
  } catch {
    return undefined;
  }
}

function formatValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return `Uint8Array(${value.length})`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "";
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isJsonValue(value: unknown): boolean {
  if (value instanceof Date || value instanceof Uint8Array) {
    return false;
  }
  return typeof value === "object" && value !== null;
}

function stringifyJson(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === "bigint") {
          return val.toString();
        }
        if (val instanceof Date) {
          return val.toISOString();
        }
        if (val instanceof Uint8Array) {
          return Array.from(val);
        }
        if (val instanceof Map) {
          return Object.fromEntries(val);
        }
        if (val instanceof Set) {
          return Array.from(val);
        }
        return val;
      },
      2,
    ) ?? ""
  );
}

function getIdParts(value: unknown): { externalId?: string; internalId?: string } | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return { externalId: String(value) };
  }
  if (typeof value === "object" && value !== null) {
    const externalId =
      "externalId" in value ? (value as { externalId?: unknown }).externalId : undefined;
    const internalId =
      "internalId" in value ? (value as { internalId?: unknown }).internalId : undefined;
    if (externalId !== undefined || internalId !== undefined) {
      return {
        externalId: externalId !== undefined ? String(externalId) : undefined,
        internalId: internalId !== undefined ? String(internalId) : undefined,
      };
    }
  }
  return null;
}

function renderValue(key: string, value: unknown) {
  if (key === "id") {
    const id = getIdParts(value);
    if (id) {
      return (
        <div className="id-pill">
          <div>
            <span className="id-pill__label">External</span>
            <span className="id-pill__value mono">{id.externalId ?? "—"}</span>
          </div>
          <div>
            <span className="id-pill__label">Internal</span>
            <span className="id-pill__value mono">{id.internalId ?? "—"}</span>
          </div>
        </div>
      );
    }
  }

  if (isJsonValue(value)) {
    return <pre className="json-block">{stringifyJson(value)}</pre>;
  }

  return <span className="mono">{formatValue(value)}</span>;
}

function formatInlineValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "—";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return `bytes:${value.length}`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object") {
    const json = stringifyJson(value);
    return json.length > 48 ? `${json.slice(0, 45)}…` : json;
  }
  const str = String(value);
  return str.length > 48 ? `${str.slice(0, 45)}…` : str;
}

function renderInlineCell(key: string, value: unknown) {
  if (key === "id") {
    const id = getIdParts(value);
    if (id) {
      return (
        <span className="db-id">
          <span className="db-id__ext mono">{id.externalId ?? "—"}</span>
          <span className="db-id__sep">/</span>
          <span className="db-id__int mono">{id.internalId ?? "—"}</span>
        </span>
      );
    }
  }

  if (isJsonValue(value)) {
    return <span className="db-json">{formatInlineValue(value)}</span>;
  }

  return <span className="mono">{formatInlineValue(value)}</span>;
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, val) => {
        if (typeof val === "bigint") {
          return val.toString();
        }
        if (val instanceof Date) {
          return val.toISOString();
        }
        if (val instanceof Uint8Array) {
          return Array.from(val);
        }
        if (val && typeof val === "object") {
          if (seen.has(val as object)) {
            return "[Circular]";
          }
          seen.add(val as object);
          if (!Array.isArray(val)) {
            const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
              a.localeCompare(b),
            );
            return Object.fromEntries(entries);
          }
        }
        return val;
      }) ?? ""
    );
  } catch {
    return String(value);
  }
}

function getRowSignature(row: Record<string, unknown>): string {
  const id = getIdParts(row["id"]);
  if (id?.externalId || id?.internalId) {
    return `id:${id.externalId ?? ""}:${id.internalId ?? ""}`;
  }
  return stableStringify(row);
}

function orderRowEntries(row: Record<string, unknown>): [string, unknown][] {
  const entries = Object.entries(row);
  entries.sort(([a], [b]) => {
    if (a === "id") {
      return -1;
    }
    if (b === "id") {
      return 1;
    }
    return a.localeCompare(b);
  });
  return entries;
}

function isDbClosingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /database connection is closing/i.test(error.message);
}
