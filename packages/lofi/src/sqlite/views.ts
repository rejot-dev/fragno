import type { LofiSchemaRegistration } from "../types";
import type { LofiSqliteSyncConnection } from "./sync-connection";

/**
 * Maintains one kind of live view of the replica, in the leading tab's worker. Pages ask for views
 * of a kind with queries in the engine's terms. The leader calls the engine's views only while it
 * holds a lock on the database, so they read synchronously.
 */
export type LofiSqliteViewEngine = {
  /** Names the kind of views the engine maintains, such as `"automation-reads"`. */
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
