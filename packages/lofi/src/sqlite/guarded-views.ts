import { quoteSqliteIdentifier } from "./layout";
import { createTrackingReader, sameData, type LofiSqliteReader } from "./read-views";
import {
  LofiSqliteAccessError,
  type LofiSqliteAccess,
  type LofiSqliteGuard,
  type LofiSqliteSyncConnection,
  type LofiSqliteSyncStatement,
} from "./sync-connection";
import type { SqliteValue } from "./values";
import { readsChangedTable, type LofiSqliteViewEngine } from "./views";

/**
 * A relation computed in JavaScript from the replica, which queries read as a temporary table. It
 * keeps logic that SQL would repeat, such as a fold, in one place.
 */
export type LofiSqliteDerivedRelation = {
  /** The relation's columns, in the order of each row's values. */
  columns: readonly string[];
  /**
   * Computes every row. It runs again, before the next query that reads the relation, once a batch
   * wrote a table its last run read.
   */
  compute(reader: LofiSqliteReader): readonly (readonly SqliteValue[])[];
};

export type LofiSqliteGuardedViewsOptions = {
  kind: string;
  /**
   * The views queries read, by name, each the SELECT it runs over the replica's tables. They are a
   * convenience, not a boundary: queries can read the replica's tables too.
   */
  views: Readonly<Record<string, string>>;
  /** Relations computed from the replica, by name. */
  derived: Readonly<Record<string, LofiSqliteDerivedRelation>>;
  /**
   * The operations, in thousands, one run of a query may take; a run that takes more fails, so a
   * query that never ends cannot stall the leader.
   */
  operations: number;
};

/** A guarded view's query: one statement over the engine's relations, and its parameters. */
export type LofiSqliteGuardedQuery = { sql: string; params: readonly SqliteValue[] };

/** A guarded view's data: its rows, or why the query cannot run. */
export type LofiSqliteGuardedResult =
  | { status: "ready"; columns: string[]; rows: SqliteValue[][] }
  | { status: "error"; message: string };

const SQLITE_PRAGMA = 19;
const SQLITE_TRANSACTION = 22;
const SQLITE_ATTACH = 24;
const SQLITE_DETACH = 25;
const SQLITE_SAVEPOINT = 32;

/**
 * Maintains views of queries that people or agents write, such as a page's. A query reads: it
 * cannot write, end or open transactions, attach databases, or set a pragma, and stops when it
 * takes too much work. Each runs again after a batch that wrote a table it reads, and reports its
 * rows only when they changed.
 *
 * Queries run inside the leader's read transaction, which SQLite rolls back whole when a write fails
 * with `OR ROLLBACK` or is interrupted, so a savepoint could not undo a query's writes: the engine
 * refuses them instead.
 *
 * The relations are temporary views and tables on the leader's connection, which give queries
 * shorter names and app-computed rows. Queries can read the replica's own tables too: the replica
 * holds only what its backend already sent the page, so the engine protects the leader, not data.
 */
export function guardedSqlViewEngine(options: LofiSqliteGuardedViewsOptions): LofiSqliteViewEngine {
  const relations = [...Object.keys(options.views), ...Object.keys(options.derived)];
  if (new Set(relations).size !== relations.length) {
    throw new Error("A guarded view and a derived relation share a name.");
  }
  const guard: LofiSqliteGuard = {
    authorize: ({ action, details }) => {
      switch (action) {
        case SQLITE_TRANSACTION:
        case SQLITE_SAVEPOINT:
        case SQLITE_ATTACH:
        case SQLITE_DETACH:
          return false;
        case SQLITE_PRAGMA:
          // A pragma given a value sets it; one without reads it.
          return details[1] === null;
        default:
          return true;
      }
    },
    maxOperations: options.operations,
  };
  const describe = (error: unknown) => describeError(error, relations);

  return {
    kind: options.kind,
    open({ connection }) {
      const run = (sql: string) => {
        Array.from(connection.prepare(sql).rows([]));
      };
      // Temporary relations stay in memory, not in files beside the replica's.
      run(`PRAGMA temp_store = MEMORY`);
      for (const [name, { columns }] of Object.entries(options.derived)) {
        run(`DROP TABLE IF EXISTS temp.${quoteSqliteIdentifier(name)}`);
        run(
          `CREATE TEMP TABLE ${quoteSqliteIdentifier(name)} (${columns.map(quoteSqliteIdentifier).join(", ")})`,
        );
      }
      for (const [name, select] of Object.entries(options.views)) {
        run(`DROP VIEW IF EXISTS temp.${quoteSqliteIdentifier(name)}`);
        run(`CREATE TEMP VIEW ${quoteSqliteIdentifier(name)} AS ${select}`);
      }

      const derived = createDerivedRelations(connection, options.derived);
      const views = new Map<
        string,
        {
          statement: LofiSqliteSyncStatement | null;
          params: readonly SqliteValue[];
          result: LofiSqliteGuardedResult;
          listener: (data: unknown) => void;
        }
      >();
      const read = (
        statement: LofiSqliteSyncStatement,
        params: readonly SqliteValue[],
      ): LofiSqliteGuardedResult => {
        const failed = derived.failure(statement.tables);
        if (failed !== null) {
          return { status: "error", message: failed };
        }
        try {
          return connection.guarded(guard, () => ({
            status: "ready",
            columns: [...statement.columnNames],
            rows: Array.from(statement.rows(params)),
          }));
        } catch (error) {
          return { status: "error", message: describe(error) };
        }
      };

      return {
        materialize(id, query, listener) {
          const { sql, params } = query as LofiSqliteGuardedQuery;
          derived.update(new Set());
          let statement: LofiSqliteSyncStatement | null = null;
          let result: LofiSqliteGuardedResult;
          try {
            const prepared = connection.guarded(guard, () => connection.prepare(sql));
            // A view's query and parameters never change, so one that fails here keeps no statement
            // to refresh.
            if (!prepared.isReadOnly) {
              result = { status: "error", message: "Queries only read: they cannot write." };
            } else if (prepared.parameterCount === params.length) {
              statement = prepared;
              result = read(statement, params);
            } else {
              result = {
                status: "error",
                message: `The query takes ${prepared.parameterCount} parameters, and was given ${params.length}.`,
              };
            }
          } catch (error) {
            result = { status: "error", message: describe(error) };
          }
          views.set(id, { statement, params, result, listener });
          listener(result);
        },
        destroy(id) {
          views.delete(id);
        },
        refresh(changed) {
          if (views.size === 0) {
            derived.invalidate(changed);
            return;
          }
          const updated = derived.update(changed);
          const affected = changed === null ? null : new Set([...changed, ...updated]);
          for (const view of views.values()) {
            const { statement } = view;
            if (statement === null || !readsChangedTable(statement.tables, affected)) {
              continue;
            }
            const result = read(statement, view.params);
            if (!sameData(result, view.result)) {
              view.result = result;
              view.listener(result);
            }
          }
        },
      };
    },
  };
}

/**
 * The derived relations' temporary tables, rewritten when their rows change. A relation is
 * computed only while views exist, and again once a table its last computation read changed.
 */
function createDerivedRelations(
  connection: LofiSqliteSyncConnection,
  relations: Readonly<Record<string, LofiSqliteDerivedRelation>>,
) {
  const { reader, track } = createTrackingReader(connection);
  const states = Object.entries(relations).map(([name, relation]) => {
    const table = `temp.${quoteSqliteIdentifier(name)}`;
    return {
      name,
      relation,
      clear: connection.prepare(`DELETE FROM ${table}`),
      insert: connection.prepare(
        `INSERT INTO ${table} VALUES (${relation.columns.map(() => "?").join(", ")})`,
      ),
      // Null until computed.
      tables: null as ReadonlySet<string> | null,
      stale: true,
      rows: [] as readonly (readonly SqliteValue[])[],
      error: null as string | null,
    };
  });
  const isStale = (state: (typeof states)[number], changed: ReadonlySet<string> | null) =>
    state.stale || state.tables === null || readsChangedTable(state.tables, changed);

  return {
    /** Marks the relations that read a changed table as stale, without computing them. */
    invalidate(changed: ReadonlySet<string> | null) {
      for (const state of states) {
        state.stale = isStale(state, changed);
      }
    },
    /** Computes the stale relations, and returns the names of those whose rows changed. */
    update(changed: ReadonlySet<string> | null): string[] {
      const updated: string[] = [];
      for (const state of states) {
        if (!isStale(state, changed)) {
          continue;
        }
        state.stale = false;
        try {
          const { result, tables } = track(() => state.relation.compute(reader));
          const recovered = state.error !== null;
          state.tables = tables;
          state.error = null;
          // Views that read a relation that failed report its error until it recovers.
          if (!recovered && sameData(result, state.rows)) {
            continue;
          }
          state.rows = result;
          Array.from(state.clear.rows([]));
          for (const row of result) {
            Array.from(state.insert.rows(row));
          }
        } catch (error) {
          // Computed again after the next batch, which may have fixed what it read.
          state.tables = null;
          state.error = `The relation ${state.name} could not be computed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        updated.push(state.name);
      }
      return updated;
    },
    /** Why a query reading `tables` cannot run, if a relation it reads failed. */
    failure(tables: ReadonlySet<string>): string | null {
      return states.find((state) => state.error !== null && tables.has(state.name))?.error ?? null;
    },
  };
}

function describeError(error: unknown, relations: readonly string[]): string {
  if (error instanceof LofiSqliteAccessError) {
    return describeAccess(error.access);
  }
  const message =
    error instanceof Error ? error.message.replace(/^SQLite error \d+: /, "") : String(error);
  return message.startsWith("no such table:")
    ? `${message}. Read one of: ${relations.join(", ")}.`
    : message;
}

function describeAccess({ action }: LofiSqliteAccess) {
  switch (action) {
    case SQLITE_PRAGMA:
      return "Queries can read a pragma, but not set it.";
    case SQLITE_ATTACH:
    case SQLITE_DETACH:
      return "Queries cannot attach or detach databases.";
    default:
      return "Queries cannot begin or end transactions.";
  }
}
