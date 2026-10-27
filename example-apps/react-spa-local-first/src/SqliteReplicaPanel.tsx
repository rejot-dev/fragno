import {
  connectLofiSqlite,
  lofiSqliteReadViews,
  type LofiSqliteClient,
  type LofiSqliteView,
  type LofiSqliteViewResult,
} from "@fragno-dev/lofi/sqlite";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { REPLICA_READS, type replicaReads } from "./replica-reads";
import { LOCAL_SCHEMAS, REGISTERED_SCHEMAS } from "./schemas";

type Row = Record<string, unknown>;

const readView = lofiSqliteReadViews<typeof replicaReads>(REPLICA_READS);
const LOADING: LofiSqliteViewResult<never> = { status: "loading" };

/**
 * Mirrors the backend's outbox into an OPFS SQLite database, in a worker, and queries it with
 * plain SQL. The workers of this page's tabs elect one, which opens the database and keeps every
 * tab's views up to date.
 */
export function SqliteReplicaPanel({ baseUrl }: { baseUrl: string }) {
  const [client, setClient] = useState<LofiSqliteClient | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [sql, setSql] = useState("");
  const [submittedSql, setSubmittedSql] = useState("");

  useEffect(() => {
    let cancelled = false;
    setOpenError(null);
    // The worker reads the backend's base URL from its name.
    const worker = new Worker(new URL("./sqlite-replica.worker.ts", import.meta.url), {
      type: "module",
      name: baseUrl,
    });
    connectLofiSqlite({
      port: worker,
      schemas: [...REGISTERED_SCHEMAS, ...LOCAL_SCHEMAS].map((schema) => ({ schema })),
    }).then(
      (next) => {
        if (!cancelled) {
          setClient(next);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setOpenError(String(error));
        }
      },
    );
    return () => {
      cancelled = true;
      setClient(null);
      worker.terminate();
    };
  }, [baseUrl]);

  const selectTable = (name: string) => {
    const query = `SELECT * FROM "${name}" ORDER BY rowid DESC LIMIT 100`;
    setSql(query);
    setSubmittedSql(query);
  };

  return (
    <main className="layout layout--tables">
      <section className="panel tables">
        <div className="panel-title">
          <div>
            <h2>SQLite replica</h2>
            <p className="panel-subtitle">{baseUrl}</p>
          </div>
        </div>
        <div className="panel-body">
          {openError ? <div className="status-error">{openError}</div> : null}
          {!client && !openError ? <div className="loading">Opening OPFS database…</div> : null}
          {client ? <ReplicaTables client={client} onSelect={selectTable} /> : null}
        </div>
      </section>

      <section className="panel panel--wide">
        <div className="panel-title">
          <div>
            <h2>Query</h2>
            <p className="panel-subtitle">
              Re-runs after any tab applies outbox entries to a table it reads.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <div className="command-form">
            <label>
              SQL
              <textarea
                className="textarea mono"
                onChange={(event) => {
                  setSql(event.target.value);
                }}
                placeholder='SELECT * FROM "comment_comment"'
                rows={4}
                value={sql}
              />
            </label>
          </div>
          <div className="command-actions">
            <button
              className="btn"
              disabled={!client}
              onClick={() => {
                setSubmittedSql(sql);
              }}
              type="button"
            >
              Run
            </button>
          </div>
          {client && submittedSql.trim().length > 0 ? (
            <QueryResult client={client} sql={submittedSql} />
          ) : null}
        </div>
      </section>
    </main>
  );
}

function ReplicaTables({
  client,
  onSelect,
}: {
  client: LofiSqliteClient;
  onSelect: (table: string) => void;
}) {
  const status = useSyncExternalStore(client.subscribeStatus, client.getStatus);
  const tables = useView(useMemo(() => readView(client, "tables", undefined), [client]));
  return (
    <>
      <p className="muted" data-testid="sqlite-status">
        {status.phase === "caught-up"
          ? "Caught up"
          : `Catching up${status.fraction === null ? "" : `: ${Math.floor(status.fraction * 100)}%`}`}
      </p>
      {status.error ? <div className="status-error">{status.error}</div> : null}
      {tables.status === "error" ? <div className="status-error">{tables.message}</div> : null}
      <div className="table-list">
        {tables.status === "ready"
          ? tables.data.map((table) => (
              <button
                className="table-item"
                key={table.name}
                onClick={() => {
                  onSelect(table.name);
                }}
                type="button"
              >
                <span className="mono">{table.name}</span>
                <span className="chip">{table.rows}</span>
              </button>
            ))
          : null}
      </div>
    </>
  );
}

function QueryResult({ client, sql }: { client: LofiSqliteClient; sql: string }) {
  // A raw SQL view: its rows as SQLite returns them, which a view of any SQL can show.
  const result = useView(
    useMemo(() => client.view<Row[]>("sql", { sql, params: [] }), [client, sql]),
  );
  if (result.status === "loading") {
    return null;
  }
  if (result.status === "error") {
    return <div className="status-error">{result.message}</div>;
  }
  const rows = result.data;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="db-table-wrap">
      <table className="db-table" data-testid="sqlite-result">
        <thead>
          <tr>
            {columns.map((column) => (
              <th className="db-head" key={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {withRowKeys(rows, columns).map(({ key, row }) => (
            <tr className="db-row" key={key}>
              {columns.map((column) => (
                <td className="db-cell mono" key={column}>
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <div className="empty">No rows.</div> : null}
    </div>
  );
}

/** The live result of a replica view, which the worker maintains while a component uses it. */
function useView<TData>(view: LofiSqliteView<TData>): LofiSqliteViewResult<TData> {
  const subscribe = useCallback((onChange: () => void) => view.listen(onChange), [view]);
  const read = useCallback(() => view.get(), [view]);
  return useSyncExternalStore(subscribe, read, () => LOADING);
}

/** Keys rows by their cells, and repeated rows by how often they appeared before. */
function withRowKeys(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): Array<{ key: string; row: Record<string, unknown> }> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const cells = JSON.stringify(columns.map((column) => formatCell(row[column])));
    const repeat = seen.get(cells) ?? 0;
    seen.set(cells, repeat + 1);
    return { key: `${cells}#${repeat}`, row };
  });
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (value instanceof Uint8Array) {
    return `<${value.byteLength} bytes>`;
  }
  return String(value);
}
