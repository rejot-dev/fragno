import type { LofiSchemaRegistration } from "../types";
import type { LofiSqliteSyncConnection } from "./sync-connection";
import type { SqliteValue } from "./values";

/**
 * Maintains one kind of live view of the replica, in the leading tab's worker. Pages ask for views
 * of a kind with queries in the engine's terms. The leader calls the engine's views only while it
 * holds a lock on the database, so they read synchronously.
 */
export type LofiSqliteViewEngine = {
  /** Names the kind of views the engine maintains, such as `"sql"`. */
  readonly kind: string;
  /** Starts maintaining views on the leader's connection, which only the replica writes. */
  open(context: {
    connection: LofiSqliteSyncConnection;
    registrations: readonly LofiSchemaRegistration[];
  }): LofiSqliteViews;
};

export type LofiSqliteViews = {
  /**
   * Builds the view of `query` and reports its data now and whenever it changes. A query that can
   * never run, such as SQL that does not parse, throws. A run that fails, when the view is built or
   * refreshed, reports it to `fail`, and the view runs again after later batches and reports its
   * data once a run succeeds, even if the data is what it was before.
   */
  materialize(
    id: string,
    query: unknown,
    listener: (data: unknown) => void,
    fail: (error: unknown) => void,
  ): void;
  destroy(id: string): void;
  /**
   * Brings the views up to date after the replica applied entries. `changed` names the tables the
   * entries wrote, by SQL name; views that read none of them can skip their refresh. Null when the
   * tables are unknown, in which case every view refreshes. A view that fails reports it to its
   * `fail`; the views engine throws only if it cannot refresh at all, and then gets the tables
   * again with the next batch's.
   */
  refresh(changed: ReadonlySet<string> | null): void;
};

/** Whether a view that reads `tables` may have changed. */
export function readsChangedTable(
  tables: ReadonlySet<string>,
  changed: ReadonlySet<string> | null,
): boolean {
  if (changed === null) {
    return true;
  }
  for (const table of tables) {
    if (changed.has(table)) {
      return true;
    }
  }
  return false;
}

/** A SQL view's query, as pages send it. */
export type LofiSqliteSqlViewQuery = { sql: string; params: readonly SqliteValue[] };

/** The rows of a SQL view, by column name. */
export type LofiSqliteRawRow = Record<string, SqliteValue>;

/**
 * Runs each SQL view again after every batch that wrote a table it reads, and reports its rows only
 * when they changed. A query that would write is refused, since writes would bypass the replica.
 */
export const sqlViewEngine: LofiSqliteViewEngine = {
  kind: "sql",
  open({ connection }) {
    type SqlView = {
      read: () => LofiSqliteRawRow[];
      tables: ReadonlySet<string>;
      rows: LofiSqliteRawRow[];
      failed: boolean;
      listener: (data: unknown) => void;
      fail: (error: unknown) => void;
    };
    const views = new Map<string, SqlView>();
    const update = (view: SqlView) => {
      let rows: LofiSqliteRawRow[];
      try {
        rows = view.read();
      } catch (error) {
        view.failed = true;
        view.fail(error);
        return;
      }
      if (view.failed || !sameRows(rows, view.rows)) {
        view.failed = false;
        view.rows = rows;
        view.listener(rows);
      }
    };

    return {
      materialize(id, query, listener, fail) {
        const { sql, params } = query as LofiSqliteSqlViewQuery;
        const statement = connection.prepare(sql);
        if (!statement.isReadOnly) {
          throw new Error(`A SQL view must not write: ${sql}`);
        }
        const view: SqlView = {
          read: () =>
            Array.from(statement.rows(params), (values) =>
              Object.fromEntries(statement.columnNames.map((name, index) => [name, values[index]])),
            ),
          tables: statement.tables,
          rows: [],
          // Reports its first rows, like a recovery.
          failed: true,
          listener,
          fail,
        };
        views.set(id, view);
        update(view);
      },
      destroy(id) {
        views.delete(id);
      },
      refresh(changed) {
        for (const view of views.values()) {
          if (readsChangedTable(view.tables, changed)) {
            update(view);
          }
        }
      },
    };
  },
};

function sameRows(left: LofiSqliteRawRow[], right: LofiSqliteRawRow[]): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const other = right[index];
      return Object.keys(row).every((column) => sameValue(row[column], other[column]));
    })
  );
}

function sameValue(left: SqliteValue, right: SqliteValue): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  }
  return left === right;
}
