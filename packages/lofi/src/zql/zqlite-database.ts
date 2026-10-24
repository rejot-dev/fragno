// Stands in for zqlite's `db.ts`, which wraps a native SQLite binding, in the vendored TableSource;
// see scripts/vendor-zql.mjs. Only the methods TableSource and its statement cache call exist.

import type { SQLiteValue } from "./vendor/zqlite/src/table-source.ts";

/**
 * A synchronous SQLite connection. IVM operators pull rows in the middle of a push, so a source
 * cannot wait for its database.
 */
export type LofiZqlConnection = {
  prepare(sql: string): LofiZqlStatement;
};

export type LofiZqlStatement = {
  /** The result columns, in the order of a row's values. */
  readonly columnNames: readonly string[];
  /**
   * Runs the statement and yields each row's values, with integers outside the safe range as
   * bigints. Returning the iterator early ends the run.
   */
  rows(params: readonly unknown[]): IterableIterator<SQLiteValue[]>;
};

export class Database {
  readonly #connection: LofiZqlConnection;

  constructor(connection: LofiZqlConnection) {
    this.#connection = connection;
  }

  prepare(sql: string): Statement {
    return new Statement(this.#connection.prepare(sql));
  }
}

export class Statement {
  readonly #statement: LofiZqlStatement;
  #raw = false;

  constructor(statement: LofiZqlStatement) {
    this.#statement = statement;
  }

  /** Integers outside the safe range are always read as bigints. */
  safeIntegers(_useBigInt: boolean): this {
    return this;
  }

  raw(enabled: boolean): this {
    this.#raw = enabled;
    return this;
  }

  columns(): { name: string }[] {
    return this.#statement.columnNames.map((name) => ({ name }));
  }

  run(...params: unknown[]): void {
    for (const _ of this.#statement.rows(params)) {
      // Writes return no rows; draining runs the statement to completion.
    }
  }

  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- TableSource passes the row type, as to zqlite's own statements.
  get<T>(...params: unknown[]): T {
    const rows = this.#statement.rows(params);
    const first = rows.next();
    rows.return?.();
    return (first.done ? undefined : this.#shape(first.value)) as T;
  }

  all<T>(...params: unknown[]): T[] {
    return Array.from(this.#statement.rows(params), (values) => this.#shape(values) as T);
  }

  batches(params: readonly unknown[]): BatchCursor {
    return new BatchCursor(this.#statement.rows(params));
  }

  /** Statements report no scan status, which TableSource only reads in debug mode. */
  scanStatus(_index: number, _op: number, _flags: number): undefined {
    return undefined;
  }

  scanStatusReset(): void {}

  #shape(values: SQLiteValue[]): unknown {
    if (this.#raw) {
      return values;
    }
    return Object.fromEntries(
      this.#statement.columnNames.map((name, index) => [name, values[index]]),
    );
  }
}

export class BatchCursor {
  readonly #rows: IterableIterator<SQLiteValue[]>;
  #done = false;

  constructor(rows: IterableIterator<SQLiteValue[]>) {
    this.#rows = rows;
  }

  /** Reads up to `capacity` rows into one row-major array, empty once the rows are exhausted. */
  next(capacity: number): SQLiteValue[] {
    const values: SQLiteValue[] = [];
    for (let read = 0; read < capacity && !this.#done; read++) {
      const row = this.#rows.next();
      if (row.done) {
        this.#done = true;
      } else {
        values.push(...row.value);
      }
    }
    return values;
  }

  close(): void {
    if (!this.#done) {
      this.#done = true;
      this.#rows.return?.();
    }
  }
}
