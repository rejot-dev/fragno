import SQLite from "better-sqlite3";

import { DurableObjectDialect } from "../../sql-driver/dialects/durable-object-dialect";
import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { CloudflareDurableObjectsDriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

/**
 * Durable Object storage on in-memory SQLite, as much of it as Fragno's dialect uses: the suite then
 * runs through the dialect, which refuses queries binding more than Durable Object SQLite does.
 */
function durableObjectStorage(database: SQLite.Database) {
  let transactions: Promise<unknown> = Promise.resolve();

  function exec(query: string, ...bindings: unknown[]) {
    // Fragno sends one statement at a time, so scripts of several are not run here.
    const statement = database.prepare(query);
    if (!statement.reader) {
      return cursor([], statement.run(...bindings).changes);
    }
    const rows = statement.all(...bindings) as Record<string, unknown>[];
    return cursor(rows, statement.readonly ? 0 : rows.length);
  }

  function cursor(rows: Record<string, unknown>[], rowsWritten: number) {
    return {
      rowsRead: rows.length,
      rowsWritten,
      toArray: () => rows,
      [Symbol.iterator]: () => rows.values(),
    };
  }

  // Asynchronous transactions run one at a time, as Durable Object storage runs them.
  async function transaction<T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T> {
    database.exec("BEGIN");
    let rolledBack = false;
    try {
      const result = await closure({ rollback: () => (rolledBack = true) });
      database.exec(rolledBack ? "ROLLBACK" : "COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    sql: { exec },
    transaction: <T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T> => {
      const running = transactions.then(() => transaction(closure));
      transactions = running.catch(() => undefined);
      return running;
    },
  };
}

describeQueryEngineSuite({
  name: "generic-sql durable objects",
  createAdapter: async () => {
    const database = new SQLite(":memory:");
    const adapter = new SqlAdapter({
      dialect: new DurableObjectDialect({
        ctx: { storage: durableObjectStorage(database) } as never,
        queryInstrumentation: null,
      }),
      driverConfig: new CloudflareDurableObjectsDriverConfig(),
    });
    return {
      adapter,
      close: async () => {
        await adapter.close();
        database.close();
      },
    };
  },
  capabilities: {
    constraints: false,
  },
});
