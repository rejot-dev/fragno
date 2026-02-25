import SQLite from "better-sqlite3";
import { CompiledQuery, SqliteDialect } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { SqlDriverAdapter } from "../../../sql-driver/sql-driver-adapter";
import { executeMigration, type CompiledMigration } from "./executor";

describe("executeMigration", () => {
  const sqliteDatabase = new SQLite(":memory:");
  const dialect = new SqliteDialect({ database: sqliteDatabase });
  const adapter = new SqlDriverAdapter(dialect);

  afterAll(async () => {
    await adapter.destroy();
    sqliteDatabase.close();
  });

  it("runs foreign_keys pragmas outside the transaction", async () => {
    const calls: string[] = [];

    const driver = {
      executeQuery: async (statement: CompiledQuery) => {
        calls.push(`exec:${statement.sql}`);
        return { rows: [] };
      },
      transaction: async (callback: (trx: SqlDriverAdapter) => Promise<void>) => {
        calls.push("tx:begin");
        const tx = {
          executeQuery: async (statement: CompiledQuery) => {
            calls.push(`tx:${statement.sql}`);
            return { rows: [] };
          },
        } as unknown as SqlDriverAdapter;
        await callback(tx);
        calls.push("tx:commit");
      },
    } as unknown as SqlDriverAdapter;

    await executeMigration(driver, {
      statements: [
        CompiledQuery.raw("PRAGMA foreign_keys = OFF"),
        CompiledQuery.raw("alter table users rename to users_tmp"),
        CompiledQuery.raw("PRAGMA foreign_keys = ON"),
      ],
      fromVersion: 0,
      toVersion: 1,
    });

    expect(calls).toEqual([
      "exec:PRAGMA foreign_keys = OFF",
      "tx:begin",
      "tx:alter table users rename to users_tmp",
      "tx:commit",
      "exec:PRAGMA foreign_keys = ON",
    ]);
  });

  it("executes all migration statements", async () => {
    const migration: CompiledMigration = {
      fromVersion: 0,
      toVersion: 1,
      statements: [
        CompiledQuery.raw('create table "migrations_test" ("id" integer, "name" text)'),
        CompiledQuery.raw('insert into "migrations_test" ("id", "name") values (1, \'alpha\')'),
      ],
    };

    await expect(executeMigration(adapter, migration)).resolves.toBe(undefined);

    const result = await adapter.executeQuery(
      CompiledQuery.raw('select "name" from "migrations_test" where "id" = 1'),
    );
    expect(result.rows[0]?.["name"]).toBe("alpha");
  });
});
