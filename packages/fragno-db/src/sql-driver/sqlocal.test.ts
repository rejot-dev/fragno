import { SQLocalKysely } from "sqlocal/kysely";
import { describe, expect, it } from "vitest";
import { SqlDriverAdapter } from "./sql-driver-adapter";
import type { GenericSQLPlugin } from "./query-executor/plugin";
import { sql } from "./sql";

describe("SQLocal", () => {
  it("should create a new SQLocal instance", async () => {
    const { dialect } = new SQLocalKysely(":memory:");

    const adapter = new SqlDriverAdapter(dialect);

    const query = sql`SELECT 5`.build();
    const result = await adapter.executeQuery(query);
    expect(result.rows).toEqual([{ 5: 5 }]);

    console.log(result);

    await adapter.destroy();
  });

  it("should execute queries in a transaction and commit", async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const adapter = new SqlDriverAdapter(dialect);

    // Create table outside transaction
    await adapter.executeQuery(sql`CREATE TABLE test (id INTEGER, name TEXT)`.build());

    // Execute queries in transaction
    await adapter.transaction(async (trx) => {
      await trx.executeQuery(sql`INSERT INTO test VALUES (1, 'Alice')`.build());
      await trx.executeQuery(sql`INSERT INTO test VALUES (2, 'Bob')`.build());
    });

    // Verify data persists after transaction
    const result = await adapter.executeQuery(sql`SELECT * FROM test ORDER BY id`.build());
    expect(result.rows).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    await adapter.destroy();
  });

  it("should rollback transaction on error", async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const adapter = new SqlDriverAdapter(dialect);

    // Create table outside transaction
    await adapter.executeQuery(sql`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)`.build());
    await adapter.executeQuery(sql`INSERT INTO test VALUES (1, 'Alice')`.build());

    // Try to execute queries in transaction with duplicate key error
    await expect(
      adapter.transaction(async (trx) => {
        await trx.executeQuery(sql`INSERT INTO test VALUES (2, 'Bob')`.build());
        // This should cause a duplicate key error
        await trx.executeQuery(sql`INSERT INTO test VALUES (1, 'Charlie')`.build());
      }),
    ).rejects.toThrow();

    // Verify Bob was not inserted (transaction rolled back)
    const result = await adapter.executeQuery(sql`SELECT * FROM test ORDER BY id`.build());
    expect(result.rows).toEqual([{ id: 1, name: "Alice" }]);

    await adapter.destroy();
  });

  it("should support plugins that transform results", async () => {
    const { dialect } = new SQLocalKysely(":memory:");
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

    await adapterWithPlugin.executeQuery(sql`CREATE TABLE test (id INTEGER, name TEXT)`.build());
    await adapterWithPlugin.executeQuery(sql`INSERT INTO test VALUES (1, 'Alice')`.build());

    const result = await adapterWithPlugin.executeQuery(sql`SELECT * FROM test`.build());

    expect(result.rows).toEqual([{ id: 1, name: "Alice", __metadata: { transformed: true } }]);

    await adapter.destroy();
  });

  it("should properly destroy and release resources", async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const adapter = new SqlDriverAdapter(dialect);

    // Execute some queries
    await adapter.executeQuery(sql`SELECT 1`.build());

    // Destroy should complete without error
    await expect(adapter.destroy()).resolves.toBeUndefined();

    // Multiple destroy calls should be safe
    await expect(adapter.destroy()).resolves.toBeUndefined();
  });
});
