import { assert, describe, expect, it } from "vitest";

import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { GenericSQLPlugin } from "./query-executor/plugin";
import { sql } from "./sql";
import { SqlDriverAdapter } from "./sql-driver-adapter";

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

  it("retains and releases the connection while streaming, including early cancellation", async () => {
    const dialect = new SqliteDialect({ database: new SQLite(":memory:") });
    const adapter = new SqlDriverAdapter(dialect);
    await adapter.executeQuery(sql`CREATE TABLE test (id INTEGER)`.compile(dialect));
    await adapter.executeQuery(sql`INSERT INTO test VALUES (1), (2)`.compile(dialect));
    const db = new Kysely<{ test: { id: number } }>({ dialect });
    const query = db.selectFrom("test").select("id").orderBy("id").compile();
    const iterator = adapter.streamQuery(query, 1);

    expect((await iterator.next()).value?.rows).toEqual([{ id: 1 }]);
    let nextQueryFinished = false;
    const nextQuery = adapter.executeQuery(sql`SELECT 3`.compile(dialect)).then((result) => {
      nextQueryFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(!nextQueryFinished);

    await iterator.return?.(undefined);
    expect((await nextQuery).rows).toEqual([{ 3: 3 }]);
    await adapter.destroy();
    await db.destroy();
  });

  it("releases the connection when a streamed result plugin fails", async () => {
    const dialect = new SqliteDialect({ database: new SQLite(":memory:") });
    const adapter = new SqlDriverAdapter(dialect);
    await adapter.executeQuery(sql`CREATE TABLE test (id INTEGER)`.compile(dialect));
    await adapter.executeQuery(sql`INSERT INTO test VALUES (1)`.compile(dialect));
    const db = new Kysely<{ test: { id: number } }>({ dialect });
    const failingAdapter = adapter.withPlugin({
      async transformResult() {
        throw new Error("stream result transformation failed");
      },
    });

    await expect(
      failingAdapter.streamQuery(db.selectFrom("test").select("id").compile(), 1).next(),
    ).rejects.toThrow("stream result transformation failed");
    expect((await adapter.executeQuery(sql`SELECT 2`.compile(dialect))).rows).toEqual([{ 2: 2 }]);
    await adapter.destroy();
    await db.destroy();
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
