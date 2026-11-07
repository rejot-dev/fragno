import type { SqliteValue } from "@fragno-dev/lofi/sqlite";
import Database from "better-sqlite3";

import type { SiteReplicaCursor, SiteReplicaStorage } from "../../../workers/site-replica-object";

const noRows = (rowsWritten: number): SiteReplicaCursor => ({
  columnNames: [],
  rowsWritten,
  [Symbol.iterator]: () => [][Symbol.iterator](),
});

/**
 * A site replica's copy in Node, in memory, where Cloudflare keeps it in the object's SQLite. Its
 * transactions are statements, as Node's SQLite takes them.
 */
export function sqliteSiteReplicaStorage(): SiteReplicaStorage {
  let database = new Database(":memory:");
  const exec = (sql: string, params: readonly SqliteValue[] = []): SiteReplicaCursor => {
    let statement: Database.Statement;
    try {
      statement = database.prepare(sql);
    } catch (error) {
      // As in a Durable Object, SQL that binds nothing may hold several statements.
      if (params.length === 0 && error instanceof RangeError) {
        database.exec(sql);
        return noRows(0);
      }
      throw error;
    }
    const values = params.map((value) =>
      value instanceof Uint8Array ? Buffer.from(value) : value,
    );
    if (!statement.reader) {
      const { changes } = statement.run(...values);
      return noRows(changes);
    }
    const columnNames = statement.columns().map((column) => column.name);
    return {
      columnNames,
      rowsWritten: 0,
      [Symbol.iterator]: () =>
        (statement.raw(true).iterate(...values) as IterableIterator<SqliteValue[]>)[
          Symbol.iterator
        ](),
    };
  };
  return {
    exec,
    async transaction(operation) {
      exec("BEGIN IMMEDIATE");
      try {
        const result = await operation();
        exec("COMMIT");
        return result;
      } catch (error) {
        exec("ROLLBACK");
        throw error;
      }
    },
    async deleteAll() {
      database.close();
      database = new Database(":memory:");
    },
    databaseSize: () =>
      Number(database.pragma("page_count", { simple: true })) *
      Number(database.pragma("page_size", { simple: true })),
  };
}
