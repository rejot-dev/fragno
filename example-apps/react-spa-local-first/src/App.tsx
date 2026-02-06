import { useEffect, useMemo, useRef, useState } from "react";
import type { AnySchema } from "@fragno-dev/db/schema";
import { IndexedDbAdapter, LofiClient } from "@fragno-dev/lofi";
import { commentSchema, upvoteSchema } from "@fragno-dev/fragno-db-library/schema";

type SchemaPack = {
  id: string;
  label: string;
  schemas: AnySchema[];
};

type EndpointConfig = {
  id: string;
  label: string;
  baseUrl: string;
  schemaPackId: string;
  pollIntervalMs: number;
  enabled: boolean;
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

type EndpointRuntime = {
  signature: string;
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

const SCHEMA_PACKS: SchemaPack[] = [
  {
    id: "comment",
    label: "Comment (fragno-db-comment)",
    schemas: [commentSchema],
  },
  {
    id: "rating",
    label: "Rating (fragno-db-rating)",
    schemas: [upvoteSchema],
  },
];

const DEFAULT_ENDPOINTS: EndpointConfig[] = [
  {
    id: "comment",
    label: "Comments",
    baseUrl: "http://localhost:3000/api/fragno-db-comment",
    schemaPackId: "comment",
    pollIntervalMs: 1000,
    enabled: true,
  },
  {
    id: "rating",
    label: "Ratings",
    baseUrl: "http://localhost:3000/api/fragno-db-rating",
    schemaPackId: "rating",
    pollIntervalMs: 1200,
    enabled: true,
  },
];

const schemaPackById = new Map(SCHEMA_PACKS.map((pack) => [pack.id, pack]));

export default function App() {
  const [endpoints, setEndpoints] = useStoredState<EndpointConfig[]>(
    "fragno-lofi-endpoints",
    DEFAULT_ENDPOINTS,
  );
  const [selectedEndpointId, setSelectedEndpointId] = useState<string>(endpoints[0]?.id ?? "");
  const [selectedTable, setSelectedTable] = useState<TableSelection | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [tableError, setTableError] = useState<string | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const [statuses, setStatuses] = useState<Record<string, EndpointStatus>>({});

  const runtimesRef = useRef<Map<string, EndpointRuntime>>(new Map());

  const selectedEndpoint = endpoints.find((endpoint) => endpoint.id === selectedEndpointId);

  const tableOptions = useMemo(() => {
    if (!selectedEndpoint) {
      return [] as TableSelection[];
    }
    const pack = schemaPackById.get(selectedEndpoint.schemaPackId);
    if (!pack) {
      return [] as TableSelection[];
    }
    return pack.schemas.flatMap((schema) =>
      Object.keys(schema.tables).map((tableName) => ({
        endpointId: selectedEndpoint.id,
        schemaName: schema.name,
        tableName,
      })),
    );
  }, [selectedEndpoint]);

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
    const runtimes = runtimesRef.current;
    const activeIds = new Set(endpoints.map((endpoint) => endpoint.id));

    for (const endpoint of endpoints) {
      const pack = schemaPackById.get(endpoint.schemaPackId);
      if (!pack) {
        continue;
      }
      const signature = `${endpoint.baseUrl}::${endpoint.schemaPackId}::${endpoint.pollIntervalMs}`;
      const existing = runtimes.get(endpoint.id);

      if (!existing || existing.signature !== signature) {
        existing?.dispose();
        runtimes.set(
          endpoint.id,
          createRuntime(
            endpoint,
            pack,
            signature,
            (status) => {
              setStatuses((prev) => ({
                ...prev,
                [endpoint.id]: {
                  ...prev[endpoint.id],
                  ...status,
                },
              }));
            },
            () => setSyncTick((prev) => prev + 1),
          ),
        );
      }

      const runtime = runtimes.get(endpoint.id);
      if (!runtime) {
        continue;
      }

      if (endpoint.enabled) {
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
  }, [endpoints]);

  useEffect(() => {
    return () => {
      for (const runtime of runtimesRef.current.values()) {
        runtime.dispose();
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadRows = async () => {
      if (!selectedTable) {
        setRows([]);
        setTableError(null);
        return;
      }
      const runtime = runtimesRef.current.get(selectedTable.endpointId);
      if (!runtime) {
        setRows([]);
        setTableError("Endpoint not initialized yet.");
        return;
      }
      const schema = runtime.schemas.find((s) => s.name === selectedTable.schemaName);
      if (!schema) {
        setRows([]);
        setTableError("Schema not available for this endpoint.");
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
        setRows(data as Record<string, unknown>[]);
      } catch (error) {
        if (!cancelled) {
          setTableError(formatError(error));
          setRows([]);
        }
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
  }, [selectedTable, syncTick]);

  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach((key) => keys.add(key));
    }
    return Array.from(keys);
  }, [rows]);

  const addEndpoint = () => {
    const id = crypto.randomUUID();
    setEndpoints((prev) => [
      ...prev,
      {
        id,
        label: "New endpoint",
        baseUrl: "http://localhost:3000/api/fragno-db-comment",
        schemaPackId: SCHEMA_PACKS[0]?.id ?? "comment",
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
    const runtime = runtimesRef.current.get(id);
    if (!runtime) {
      return;
    }
    await runtime.syncOnce();
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
            <strong>{endpoints.filter((endpoint) => endpoint.enabled).length}</strong>
          </div>
          <div className="hero-metric">
            <span>Tables visible</span>
            <strong>{tableOptions.length}</strong>
          </div>
        </div>
      </header>

      <main className="layout">
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
                      Schema pack
                      <select
                        className="input"
                        value={endpoint.schemaPackId}
                        onChange={(event) =>
                          updateEndpoint(endpoint.id, { schemaPackId: event.target.value })
                        }
                      >
                        {SCHEMA_PACKS.map((pack) => (
                          <option key={pack.id} value={pack.id}>
                            {pack.label}
                          </option>
                        ))}
                      </select>
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
                      <span className="mono">{status?.lastVersionstamp?.slice(0, 12) ?? "-"}</span>
                    </div>
                    {status?.error ? <div className="status-error">{status.error}</div> : null}
                  </div>

                  <div className="endpoint-actions">
                    <button
                      className="btn btn--ghost"
                      onClick={() => setSelectedEndpointId(endpoint.id)}
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

        <section className="panel tables">
          <div className="panel-title">
            <h2>Tables</h2>
            <select
              className="input"
              value={selectedEndpointId}
              onChange={(event) => setSelectedEndpointId(event.target.value)}
            >
              {endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>
                  {endpoint.label}
                </option>
              ))}
            </select>
          </div>
          <div className="panel-body table-list">
            {tableOptions.map((table) => {
              const active =
                selectedTable?.endpointId === table.endpointId &&
                selectedTable?.schemaName === table.schemaName &&
                selectedTable?.tableName === table.tableName;
              return (
                <button
                  className={`table-item${active ? "table-item--active" : ""}`}
                  key={`${table.schemaName}.${table.tableName}`}
                  onClick={() => setSelectedTable(table)}
                  type="button"
                >
                  <span className="mono">
                    {table.schemaName}.{table.tableName}
                  </span>
                </button>
              );
            })}
            {!tableOptions.length ? (
              <div className="empty">No tables available for this endpoint.</div>
            ) : null}
          </div>
        </section>

        <section className="panel data">
          <div className="panel-title">
            <h2>Rows</h2>
            <div className="panel-subtitle">
              {selectedTable ? (
                <span className="mono">
                  {selectedTable.schemaName}.{selectedTable.tableName}
                </span>
              ) : (
                <span>Select a table to inspect</span>
              )}
            </div>
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
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {columns.map((column) => (
                          <td key={column}>
                            <span className="mono">{formatValue(row[column])}</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}

function createRuntime(
  endpoint: EndpointConfig,
  pack: SchemaPack,
  signature: string,
  onStatus: (status: EndpointStatus) => void,
  onDataChange: () => void,
): EndpointRuntime {
  const outboxUrl = buildOutboxUrl(endpoint.baseUrl);
  const adapter = new IndexedDbAdapter({
    endpointName: endpoint.id,
    schemas: pack.schemas.map((schema) => ({ schema })),
  });

  const client = new LofiClient({
    outboxUrl,
    endpointName: endpoint.id,
    adapter,
    pollIntervalMs: endpoint.pollIntervalMs,
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
    }, endpoint.pollIntervalMs);
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
    adapter,
    client,
    schemas: pack.schemas,
    outboxUrl,
    pollIntervalMs: endpoint.pollIntervalMs,
    timer,
    syncOnce,
    start,
    stop,
    dispose,
  };
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

function buildOutboxUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.pathname.endsWith("/_internal/outbox")) {
    return url.toString();
  }
  const trimmed = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${trimmed}/_internal/outbox`;
  return url.toString();
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
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") {
    return "";
  }
  return String(value);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
