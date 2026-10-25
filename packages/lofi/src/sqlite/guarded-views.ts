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
   * The views queries read, by name, each the SELECT it runs over the replica's tables. Queries
   * read the replica only through these and `derived`, so its table names and bookkeeping columns
   * can change under them.
   */
  views: Readonly<Record<string, string>>;
  /** Relations computed from the replica, by name. */
  derived: Readonly<Record<string, LofiSqliteDerivedRelation>>;
  /** The SQL functions queries may call, such as `count` or `json_extract`, in any case. */
  functions: readonly string[];
  limits: LofiSqliteGuardedLimits;
};

export type LofiSqliteGuardedLimits = {
  /** The rows a view holds. It drops the rest, and says so. */
  rows: number;
  /** The bytes of text and blobs a view's rows may hold; a view that would hold more fails. */
  bytes: number;
  /** The operations, in thousands, one run of a query may take; a run that takes more fails. */
  operations: number;
  /** The longest string or blob, in bytes, a query may produce. */
  length: number;
};

/** A guarded view's query: one SELECT over the engine's relations, and its parameters. */
export type LofiSqliteGuardedQuery = { sql: string; params: readonly SqliteValue[] };

/** A guarded view's data: its rows, or why the query cannot run. */
export type LofiSqliteGuardedResult =
  | {
      status: "ready";
      columns: string[];
      rows: SqliteValue[][];
      /** Whether the query had more rows than the view holds. */
      truncated: boolean;
    }
  | { status: "error"; message: string };

const SQLITE_READ = 20;
const SQLITE_SELECT = 21;
const SQLITE_FUNCTION = 31;
const SQLITE_RECURSIVE = 33;
// Table-valued functions, which SQLite reports as tables of the main database.
const TABLE_FUNCTIONS = new Set(["json_each", "json_tree"]);

/**
 * Maintains views of queries that people or agents write, such as a page's, which the replica must
 * survive: a query reads only the engine's relations, calls only its functions, cannot write or
 * change settings, and stops when it takes too much work or returns too much data. Each runs again
 * after a batch that wrote a table it reads, and reports its rows only when they changed.
 *
 * The relations are temporary views and tables on the leader's connection. The guard keeps
 * queries off the replica's own tables with two exceptions SQLite's authorizer cannot tell apart:
 * a CTE named like a view, since reads inside a CTE are reported as made through it, and
 * `count(*)` of a table, which reads none of its columns.
 */
export function guardedSqlViewEngine(options: LofiSqliteGuardedViewsOptions): LofiSqliteViewEngine {
  const relations = [...Object.keys(options.views), ...Object.keys(options.derived)];
  if (new Set(relations).size !== relations.length) {
    throw new Error("A guarded view and a derived relation share a name.");
  }
  const viewNames = new Set(Object.keys(options.views));
  const relationNames = new Set(relations);
  const functions = new Set(options.functions.map((name) => name.toLowerCase()));
  const guard: LofiSqliteGuard = {
    authorize: (access) => {
      switch (access.action) {
        case SQLITE_SELECT:
        case SQLITE_RECURSIVE:
          return true;
        case SQLITE_READ: {
          const [table, column] = access.details;
          if (access.database === "main") {
            return (
              (access.source !== null && viewNames.has(access.source)) ||
              TABLE_FUNCTIONS.has(table ?? "")
            );
          }
          if (access.database === "temp") {
            return table !== null && relationNames.has(table);
          }
          // count(*) reads a table without its columns, of whatever its FROM names.
          return column === null;
        }
        case SQLITE_FUNCTION:
          return functions.has(access.details[1]?.toLowerCase() ?? "");
        default:
          return false;
      }
    },
    maxOperations: options.limits.operations,
    maxLength: options.limits.length,
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
          return connection.guarded(guard, () => readRows(statement, params, options.limits));
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
            if (prepared.parameterCount === params.length) {
              statement = prepared;
              result = read(statement, params);
            } else {
              // A view's query and parameters never change, so it keeps no statement to refresh.
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

/** Steps through the statement's rows within the limits. */
function readRows(
  statement: LofiSqliteSyncStatement,
  params: readonly SqliteValue[],
  limits: LofiSqliteGuardedLimits,
): LofiSqliteGuardedResult {
  const rows: SqliteValue[][] = [];
  let bytes = 0;
  let truncated = false;
  for (const row of statement.rows(params)) {
    if (rows.length === limits.rows) {
      // Returning from the loop ends the run.
      truncated = true;
      break;
    }
    for (const value of row) {
      bytes +=
        typeof value === "string"
          ? utf8Length(value)
          : value instanceof Uint8Array
            ? value.byteLength
            : 8;
    }
    if (bytes > limits.bytes) {
      return {
        status: "error",
        message: `The query's rows hold more than ${limits.bytes} bytes; select fewer rows or columns.`,
      };
    }
    rows.push(row);
  }
  return { status: "ready", columns: [...statement.columnNames], rows, truncated };
}

/** The bytes of a string in UTF-8, as SQLite stores it, without encoding it. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit < 0xdc00 && index + 1 < value.length) {
      // A surrogate pair, which UTF-8 encodes in four bytes.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
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
    return describeAccess(error.access, relations);
  }
  return error instanceof Error ? error.message.replace(/^SQLite error \d+: /, "") : String(error);
}

function describeAccess({ action, details }: LofiSqliteAccess, relations: readonly string[]) {
  switch (action) {
    case SQLITE_READ:
      return `"${details[0]}" is not a relation queries can read. Read one of: ${relations.join(", ")}.`;
    case SQLITE_FUNCTION:
      return `Queries cannot call ${details[1]}().`;
    default:
      return "Queries only read: they cannot write, attach databases, or change settings.";
  }
}
