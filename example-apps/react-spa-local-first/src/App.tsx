import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnySchema } from "@fragno-dev/db/schema";
import { IndexedDbAdapter, LofiClient } from "@fragno-dev/lofi";
import { commentSchema, upvoteSchema } from "@fragno-dev/fragno-db-library/schema";

type SchemaDescriptor = {
  name: string;
  namespace: string | null;
  version: number;
  tables: string[];
};

type InternalDescribeResponse = {
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

type AppTab = "tables" | "endpoints";

type EndpointInfo = {
  signature: string;
  state: "loading" | "ready" | "error";
  adapterId?: string;
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

type AdapterGroup = {
  id: string;
  endpointIds: string[];
  outboxUrl: string;
  endpointName: string;
  schemas: AnySchema[];
  missingSchemas: string[];
  enabled: boolean;
  pollIntervalMs: number;
};

type AdapterRuntime = {
  signature: string;
  adapterId: string;
  endpointName: string;
  endpointIds: string[];
  adapter: IndexedDbAdapter;
  client: LofiClient;
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
  const [tableHighlights, setTableHighlights] = useState<Record<string, number>>({});
  const [newRowSignatures, setNewRowSignatures] = useState<string[]>([]);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

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
  const selectedTableKey = selectedTable
    ? `${selectedTable.schemaName}.${selectedTable.tableName}`
    : "";
  const selectedEndpointSummary = selectedEndpoint
    ? `${selectedEndpoint.label} · ${selectedEndpoint.baseUrl}`
    : "Choose an endpoint from the Endpoints tab.";

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
          adapterId: existing?.adapterId,
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

        const adapterId = signature;

        setEndpointInfos((prev) => ({
          ...prev,
          [endpoint.id]: {
            signature,
            state: "ready",
            adapterId,
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
            <strong>{endpoints.filter((endpoint) => endpoint.enabled).length}</strong>
          </div>
          <div className="hero-metric">
            <span>Tables visible</span>
            <strong>{tableOptions.length}</strong>
          </div>
        </div>
      </header>
      <div className="tabs">
        <button
          className={`tab${activeTab === "tables" ? "tab--active" : ""}`}
          onClick={() => setActiveTab("tables")}
          type="button"
        >
          Tables
        </button>
        <button
          className={`tab${activeTab === "endpoints" ? "tab--active" : ""}`}
          onClick={() => setActiveTab("endpoints")}
          type="button"
        >
          Endpoints
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
        </main>
      ) : (
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
                const adapterLabel = info?.adapterId
                  ? info.adapterId.slice(0, 12)
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
    adapterId: group.id,
    endpointName: group.endpointName,
    endpointIds: group.endpointIds,
    adapter,
    client,
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
      outboxUrl?: string;
      schemaNames: Set<string>;
      missingSchemas: Set<string>;
    }
  >();

  for (const endpoint of endpoints) {
    const info = endpointInfos[endpoint.id];
    const adapterId = info?.adapterId ?? `endpoint:${endpoint.id}`;
    let group = groups.get(adapterId);
    if (!group) {
      group = {
        id: adapterId,
        endpointIds: [],
        outboxUrl: undefined,
        schemaNames: new Set(),
        missingSchemas: new Set(),
      };
      groups.set(adapterId, group);
    }

    group.endpointIds.push(endpoint.id);
    if (!group.outboxUrl) {
      group.outboxUrl = buildOutboxUrl(endpoint.baseUrl);
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
    const endpointName = normalizeEndpointName(`adapter-${group.id}`);
    const outboxUrl = group.outboxUrl ?? buildOutboxUrl(endpointsInGroup[0]?.baseUrl ?? "/");
    const adapterGroup: AdapterGroup = {
      id: group.id,
      endpointIds: group.endpointIds,
      outboxUrl,
      endpointName,
      schemas,
      missingSchemas: Array.from(group.missingSchemas),
      enabled,
      pollIntervalMs,
    };

    result.push(adapterGroup);
    for (const endpointId of group.endpointIds) {
      endpointToGroup.set(endpointId, adapterGroup);
    }
  }

  return { groups: result, endpointToGroup };
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
