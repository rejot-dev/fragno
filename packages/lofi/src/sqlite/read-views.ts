import type { LofiSqliteClient, LofiSqliteView } from "./client";
import {
  decodeLofiSqliteQueryRows,
  type LofiSqliteQuery,
  type LofiSqliteQueryRow,
  type LofiSqliteResultColumn,
} from "./query";
import type { LofiSqliteSyncStatement } from "./sync-connection";
import type { LofiSqliteViewEngine } from "./views";

/** Reads the replica synchronously, decoding each row like `replica.query`. */
export type LofiSqliteReader = {
  query<TColumns extends Record<string, LofiSqliteResultColumn>>(
    query: LofiSqliteQuery<TColumns>,
  ): LofiSqliteQueryRow<TColumns>[];
};

/**
 * A read view's function. It reads the replica with any number of queries, which all see the same
 * state, and returns data that survives `postMessage`, such as rows with dates.
 */
export type LofiSqliteRead<TArgs, TData> = (reader: LofiSqliteReader, args: TArgs) => TData;

/** Read functions by name. A worker's read view engine runs them; pages ask for them by name. */
export type LofiSqliteReads = Readonly<Record<string, LofiSqliteRead<never, unknown>>>;

/** A read view's query, as pages send it. */
export type LofiSqliteReadViewQuery = { read: string; args: unknown };

/** The arguments a read takes; `unknown` for a read that takes none. */
export type LofiSqliteReadArgs<TRead> =
  TRead extends LofiSqliteRead<infer TArgs, unknown> ? TArgs : never;

/** Opens a page's read views of the reads a worker's engine of one kind runs. */
export type LofiSqliteReadViews<TReads extends LofiSqliteReads> = <
  TName extends keyof TReads & string,
>(
  client: LofiSqliteClient,
  read: TName,
  args: LofiSqliteReadArgs<TReads[TName]>,
) => LofiSqliteView<ReturnType<TReads[TName]>>;

/**
 * Opens read views of `kind` on a page. `TReads` is the type of the reads the worker's
 * `readViewEngine` of `kind` runs, so the page needs only their types.
 */
export function lofiSqliteReadViews<TReads extends LofiSqliteReads>(
  kind: string,
): LofiSqliteReadViews<TReads> {
  return (client, read, args) => {
    const query: LofiSqliteReadViewQuery = { read, args };
    return client.view(kind, query);
  };
}

// Reads with a varying number of parameters prepare a statement per count, so the cache drops the
// least recently used; a dropped statement is finalized once collected.
const STATEMENT_CACHE_SIZE = 256;

/**
 * Maintains views computed by read functions: each view runs its read again after every batch the
 * replica applied, with the database locked, so the read's queries see one state. The view reports
 * its data only when it changed. A query that would write is refused, since writes would bypass the
 * replica.
 */
export function readViewEngine(options: {
  kind: string;
  reads: LofiSqliteReads;
}): LofiSqliteViewEngine {
  return {
    kind: options.kind,
    open({ connection }) {
      const statements = new Map<string, LofiSqliteSyncStatement>();
      const prepare = (sql: string) => {
        const cached = statements.get(sql);
        if (cached) {
          statements.delete(sql);
          statements.set(sql, cached);
          return cached;
        }
        const statement = connection.prepare(sql);
        if (!statement.isReadOnly) {
          throw new Error(`A read view must not write: ${sql}`);
        }
        statements.set(sql, statement);
        if (statements.size > STATEMENT_CACHE_SIZE) {
          statements.delete(statements.keys().next().value!);
        }
        return statement;
      };
      const reader: LofiSqliteReader = {
        query(query) {
          const statement = prepare(query.sql);
          const rows = Array.from(statement.rows(query.params), (values) =>
            Object.fromEntries(statement.columnNames.map((name, index) => [name, values[index]])),
          );
          return decodeLofiSqliteQueryRows(query, rows);
        },
      };

      const views = new Map<
        string,
        { run: () => unknown; data: unknown; listener: (data: unknown) => void }
      >();
      return {
        materialize(id, query, listener) {
          const { read, args } = query as LofiSqliteReadViewQuery;
          const readFunction = Object.hasOwn(options.reads, read) ? options.reads[read] : undefined;
          if (!readFunction) {
            throw new Error(`No read named "${read}" in read views of kind "${options.kind}".`);
          }
          const run = () => readFunction(reader, args as never);
          const data = run();
          views.set(id, { run, data, listener });
          listener(data);
        },
        destroy(id) {
          views.delete(id);
        },
        refresh() {
          // One failing read leaves its view's data as it was, and the others still refresh.
          const errors: unknown[] = [];
          for (const view of views.values()) {
            try {
              const data = view.run();
              if (!sameData(data, view.data)) {
                view.data = data;
                view.listener(data);
              }
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, "Read views failed to refresh.");
          }
        },
      };
    },
  };
}

/** Whether two results of a read hold the same data: plain objects, arrays, dates, and bytes. */
function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null ||
    Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
  ) {
    return false;
  }
  if (left instanceof Date) {
    return left.getTime() === (right as Date).getTime();
  }
  if (left instanceof Uint8Array) {
    const other = right as Uint8Array;
    return left.length === other.length && left.every((byte, index) => byte === other[index]);
  }
  if (Array.isArray(left)) {
    const other = right as unknown[];
    return (
      left.length === other.length && left.every((value, index) => sameData(value, other[index]))
    );
  }
  const prototype = Object.getPrototypeOf(left) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    // Data of other classes counts as changed.
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameData(leftRecord[key], rightRecord[key]),
    )
  );
}
