import SQLite from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqlDriverAdapter } from "./sql-driver-adapter";
import type { GenericSQLPlugin } from "./query-executor/plugin";
import { sql } from "./sql";
import { SqliteDialect } from "kysely";

describe("better-sqlite3", () => {
  it("Should be able to execute queries using better-sqlite3", async () => {
    const dialect = new SqliteDialect({
      database: new SQLite(":memory:"),
    });

    const adapter = new SqlDriverAdapter(dialect);

    const query = sql`SELECT 5`.compile(dialect);
    const result = await adapter.executeQuery(query);
    expect(result.rows).toEqual([{ 5: 5 }]);

    await adapter.destroy();
  });

  it("should execute queries in a transaction and commit", async () => {
    const dialect = new SqliteDialect({
      database: new SQLite(":memory:"),
    });
    const adapter = new SqlDriverAdapter(dialect);

    // Create table outside transaction
    await adapter.executeQuery(sql`CREATE TABLE test (id INTEGER, name TEXT)`.compile(dialect));

    // Execute queries in transaction
    await adapter.transaction(async (trx) => {
      await trx.executeQuery(sql`INSERT INTO test VALUES (1, 'Alice')`.compile(dialect));
      await trx.executeQuery(sql`INSERT INTO test VALUES (2, 'Bob')`.compile(dialect));
    });

    // Verify data persists after transaction
    const result = await adapter.executeQuery(sql`SELECT * FROM test ORDER BY id`.compile(dialect));
    expect(result.rows).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    await adapter.destroy();
  });

  it("should rollback transaction on error", async () => {
    const dialect = new SqliteDialect({
      database: new SQLite(":memory:"),
    });
    const adapter = new SqlDriverAdapter(dialect);

    // Create table outside transaction
    await adapter.executeQuery(
      sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`.compile(dialect),
    );
    await adapter.executeQuery(sql`INSERT INTO test VALUES (1, 'Alice')`.compile(dialect));

    // Try to execute queries in transaction with duplicate key error
    await expect(
      adapter.transaction(async (trx) => {
        await trx.executeQuery(sql`INSERT INTO test VALUES (2, 'Bob')`.compile(dialect));
        // This should cause a duplicate key error
        await trx.executeQuery(sql`INSERT INTO test VALUES (1, 'Charlie')`.compile(dialect));
      }),
    ).rejects.toThrow();

    // Verify Bob was not inserted (transaction rolled back)
    const result = await adapter.executeQuery(sql`SELECT * FROM test ORDER BY id`.compile(dialect));
    expect(result.rows).toEqual([{ id: 1, name: "Alice" }]);

    await adapter.destroy();
  });

  it("should support plugins that transform results", async () => {
    const dialect = new SqliteDialect({
      database: new SQLite(":memory:"),
    });
    const adapter = new SqlDriverAdapter(dialect);

    // Create a plugin that adds metadata to results
    const metadataPlugin: GenericSQLPlugin = {
      async transformResult({ result }) {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...(row as object),
            __metadata: { transformed: true },
          })),
        };
      },
    };

    const adapterWithPlugin = adapter.withPlugin(metadataPlugin);

    await adapterWithPlugin.executeQuery(
      sql`CREATE TABLE test (id INTEGER, name TEXT)`.compile(dialect),
    );
    await adapterWithPlugin.executeQuery(
      sql`INSERT INTO test VALUES (1, 'Alice')`.compile(dialect),
    );

    const result = await adapterWithPlugin.executeQuery(sql`SELECT * FROM test`.compile(dialect));

    expect(result.rows).toEqual([{ id: 1, name: "Alice", __metadata: { transformed: true } }]);

    await adapter.destroy();
  });

  it("should properly destroy and release resources", async () => {
    const dialect = new SqliteDialect({
      database: new SQLite(":memory:"),
    });
    const adapter = new SqlDriverAdapter(dialect);

    // Execute some queries
    await adapter.executeQuery(sql`SELECT 1`.compile(dialect));

    // Destroy should complete without error
    await expect(adapter.destroy()).resolves.toBeUndefined();

    // Multiple destroy calls should be safe
    await expect(adapter.destroy()).resolves.toBeUndefined();
  });
});
