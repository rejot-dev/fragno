import { expect, it } from "vitest";

import { sqlStatementTransaction, SqliteLofiAdapter } from "./adapter";
import { openLofiSqliteMemoryFiles } from "./testing";

it("ends a transaction only after the statements its operation queued have run", async () => {
  const files = await openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
  const database = await files.open({ databaseName: "adapter-transaction.sqlite" });
  const calls: string[] = [];
  // Each statement takes a moment, as an OPFS write does, so statements in flight can overlap.
  const execute: typeof database.execute = async (sql, params) => {
    calls.push(`start ${sql}`);
    try {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      return await database.execute(sql, params);
    } finally {
      calls.push(`end ${sql}`);
    }
  };
  const adapter = await SqliteLofiAdapter.open({
    database: { ...database, execute, transaction: sqlStatementTransaction(execute) },
    schemas: [],
    localSchemas: [],
    projections: [],
  });
  calls.length = 0;

  // The second statement fails while the third waits behind it.
  await expect(
    adapter.read(async (db) => {
      await Promise.all([
        db.execute("SELECT 1"),
        db.execute("SELECT * FROM missing"),
        db.execute("SELECT 3"),
      ]);
    }),
  ).rejects.toThrow("no such table: missing");

  expect(calls).toEqual([
    "start BEGIN",
    "end BEGIN",
    "start SELECT 1",
    "end SELECT 1",
    "start SELECT * FROM missing",
    "end SELECT * FROM missing",
    "start SELECT 3",
    "end SELECT 3",
    "start ROLLBACK",
    "end ROLLBACK",
  ]);
  await database.close();
});
