import type { AnySchema } from "@fragno-dev/db/schema";
import type { LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";
import { openLofiSqliteReplica } from "@fragno-dev/lofi/sqlite/browser";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AnyLofiLocalProjection } from "@fragno-dev/lofi";

type SqliteReplicaPanelProps = {
  baseUrl: string;
  schemas: AnySchema[];
  localSchemas: AnySchema[];
  projections: AnyLofiLocalProjection[];
};

type TableSummary = { name: string; rows: number };

type QueryResult =
  | { state: "idle" }
  | { state: "ready"; rows: ReadonlyArray<Record<string, unknown>> }
  | { state: "error"; error: string };

declare global {
  interface Window {
    /** The open replica, for running SQL from the browser console. */
    lofiSqliteReplica?: LofiSqliteReplica;
  }
}

/**
 * Mirrors the backend's outbox into an OPFS SQLite database and queries it with plain SQL. Every
 * tab of this page reads its own connection; one tab at a time writes.
 */
export function SqliteReplicaPanel({
  baseUrl,
  schemas,
  localSchemas,
  projections,
}: SqliteReplicaPanelProps) {
  const [replica, setReplica] = useState<LofiSqliteReplica | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<Array<{ id: number; message: string }>>([]);
  const nextSyncErrorId = useRef(0);
  const [changes, setChanges] = useState(0);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [sql, setSql] = useState("");
  const [submittedSql, setSubmittedSql] = useState("");
  const [result, setResult] = useState<QueryResult>({ state: "idle" });

  useEffect(() => {
    let cancelled = false;
    let opened: LofiSqliteReplica | undefined;
    setOpenError(null);
    setSyncErrors([]);
    void openLofiSqliteReplica({
      baseUrl,
      fetch: fetch.bind(globalThis),
      schemas: schemas.map((schema) => ({ schema })),
      localSchemas: localSchemas.map((schema) => ({ schema })),
      projections,
      ephemeralTables: [],
      onError: (error) => {
        const id = nextSyncErrorId.current++;
        setSyncErrors((errors) => [...errors.slice(-4), { id, message: String(error) }]);
      },
      retryDelayMs: 5_000,
    }).then(
      (next) => {
        if (cancelled) {
          void next.close();
          return;
        }
        opened = next;
        window.lofiSqliteReplica = next;
        setReplica(next);
      },
      (error: unknown) => {
        if (!cancelled) {
          setOpenError(String(error));
        }
      },
    );
    return () => {
      cancelled = true;
      setReplica(null);
      if (opened) {
        if (window.lofiSqliteReplica === opened) {
          delete window.lofiSqliteReplica;
        }
        void opened.close();
      }
    };
  }, [baseUrl, schemas, localSchemas, projections]);

  useEffect(() => {
    if (!replica) {
      return undefined;
    }
    return replica.subscribe(() => {
      setChanges((count) => count + 1);
    });
  }, [replica]);

  const loadTables = useCallback(async (current: LofiSqliteReplica) => {
    const names = await current.execute(
      `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
    );
    return await Promise.all(
      names.map(async ({ name }) => {
        const [count] = await current.execute(`SELECT count(*) AS "rows" FROM "${String(name)}"`);
        return { name: String(name), rows: Number(count?.["rows"] ?? 0) };
      }),
    );
  }, []);

  useEffect(() => {
    if (!replica) {
      return undefined;
    }
    let cancelled = false;
    void loadTables(replica).then((next) => {
      if (!cancelled) {
        setTables(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [replica, changes, loadTables]);

  useEffect(() => {
    if (!replica || submittedSql.trim().length === 0) {
      return undefined;
    }
    let cancelled = false;
    replica.execute(submittedSql).then(
      (rows) => {
        if (!cancelled) {
          setResult({ state: "ready", rows });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setResult({ state: "error", error: String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [replica, submittedSql, changes]);

  const selectTable = (name: string) => {
    const query = `SELECT * FROM "${name}" ORDER BY rowid DESC LIMIT 100`;
    setSql(query);
    setSubmittedSql(query);
  };

  const columns =
    result.state === "ready" ? [...new Set(result.rows.flatMap((row) => Object.keys(row)))] : [];

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
          {!replica && !openError ? <div className="loading">Opening OPFS database…</div> : null}
          {replica ? (
            <>
              <p className="muted mono" data-testid="sqlite-database-name">
                {replica.databaseName}
              </p>
              <p className="muted" data-testid="sqlite-changes">
                Changes received: {changes}
              </p>
              <div className="table-list">
                {tables.map((table) => (
                  <button
                    className="table-item"
                    key={table.name}
                    onClick={() => {
                      selectTable(table.name);
                    }}
                    type="button"
                  >
                    <span className="mono">{table.name}</span>
                    <span className="chip">{table.rows}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {syncErrors.map((error) => (
            <div className="status-error" key={error.id}>
              {error.message}
            </div>
          ))}
        </div>
      </section>

      <section className="panel panel--wide">
        <div className="panel-title">
          <div>
            <h2>Query</h2>
            <p className="panel-subtitle">Re-runs whenever any tab applies outbox entries.</p>
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
              disabled={!replica}
              onClick={() => {
                setSubmittedSql(sql);
              }}
              type="button"
            >
              Run
            </button>
          </div>
          {result.state === "error" ? <div className="status-error">{result.error}</div> : null}
          {result.state === "ready" ? (
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
                  {withRowKeys(result.rows, columns).map(({ key, row }) => (
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
              {result.rows.length === 0 ? <div className="empty">No rows.</div> : null}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
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
