import type {
  NodeDurableObjectSqlCursor,
  NodeDurableObjectSqlStorage,
  NodeDurableObjectSqlValue,
} from "../runtime/node-durable-object-storage";
import type {
  ManagedNodeRuntimeObjectDatabase,
  NodeRuntimeSqlExecution,
} from "./managed-node-runtime-object-database";

/** Creates the narrow Durable Object SQL facade backed by the worker-owned object database. */
export function createNodeDurableObjectSqlStorage(
  database: ManagedNodeRuntimeObjectDatabase,
): NodeDurableObjectSqlStorage {
  return {
    exec<TRow extends Record<string, unknown>>(
      query: string,
      ...bindings: NodeDurableObjectSqlValue[]
    ) {
      return new NodeDurableObjectSqlCursorResult<TRow>(database.executeSql(query, bindings));
    },
    get databaseSize() {
      return database.databaseSize;
    },
  };
}

class NodeDurableObjectSqlCursorResult<
  TRow extends Record<string, unknown>,
> implements NodeDurableObjectSqlCursor<TRow> {
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;

  readonly #rows: TRow[];
  #offset = 0;

  constructor(execution: NodeRuntimeSqlExecution) {
    this.#rows = execution.rows as TRow[];
    this.columnNames = execution.columnNames;
    this.rowsRead = execution.rowsRead;
    this.rowsWritten = execution.rowsWritten;
  }

  next(): IteratorResult<TRow> {
    const value = this.#rows[this.#offset];
    if (value === undefined) {
      return { done: true, value: undefined as never };
    }
    this.#offset += 1;
    return { done: false, value };
  }

  toArray(): TRow[] {
    const remaining = this.#rows.slice(this.#offset);
    this.#offset = this.#rows.length;
    return remaining;
  }

  one(): TRow {
    const remaining = this.#rows.length - this.#offset;
    if (remaining !== 1) {
      throw new Error(`NODE_DURABLE_OBJECT_SQL_CURSOR_ONE_ROW_REQUIRED:${remaining}`);
    }
    const value = this.#rows[this.#offset];
    this.#offset = this.#rows.length;
    return value;
  }

  *raw<TValues extends NodeDurableObjectSqlValue[]>(): IterableIterator<TValues> {
    for (const row of this) {
      yield this.columnNames.map((name) => row[name]) as TValues;
    }
  }

  [Symbol.iterator](): IterableIterator<TRow> {
    return this;
  }
}
