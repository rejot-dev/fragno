import { afterAll, describe, expect, it } from "vitest";

import SQLite from "better-sqlite3";
import { CompiledQuery, SqliteDialect } from "kysely";

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

  it("reenables MySQL foreign key checks when a transactional statement fails", async () => {
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
            throw new Error("migration failed");
          },
        } as unknown as SqlDriverAdapter;
        await callback(tx);
      },
    } as unknown as SqlDriverAdapter;

    await expect(
      executeMigration(driver, {
        statements: [
          CompiledQuery.raw("SET FOREIGN_KEY_CHECKS = 0"),
          CompiledQuery.raw("alter table users add column tenant_id varchar(128)"),
          CompiledQuery.raw("SET FOREIGN_KEY_CHECKS = 1"),
        ],
        fromVersion: 0,
        toVersion: 1,
      }),
    ).rejects.toThrow("migration failed");

    expect(calls).toEqual([
      "exec:SET FOREIGN_KEY_CHECKS = 0",
      "tx:begin",
      "tx:alter table users add column tenant_id varchar(128)",
      "exec:SET FOREIGN_KEY_CHECKS = 1",
    ]);
  });

  it("cleans up MySQL prepared statements when execution fails", async () => {
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
            if (statement.sql === "execute fragno_db_system_migration_stmt") {
              throw new Error("prepared statement failed");
            }
            return { rows: [] };
          },
        } as unknown as SqlDriverAdapter;
        await callback(tx);
      },
    } as unknown as SqlDriverAdapter;

    await expect(
      executeMigration(driver, {
        statements: [
          CompiledQuery.raw("SET FOREIGN_KEY_CHECKS = 0"),
          CompiledQuery.raw("set @fragno_db_system_migration_stmt = 'select 1'"),
          CompiledQuery.raw(
            "prepare fragno_db_system_migration_stmt from @fragno_db_system_migration_stmt",
          ),
          CompiledQuery.raw("execute fragno_db_system_migration_stmt"),
          CompiledQuery.raw("deallocate prepare fragno_db_system_migration_stmt"),
          CompiledQuery.raw("SET FOREIGN_KEY_CHECKS = 1"),
        ],
        fromVersion: 0,
        toVersion: 1,
      }),
    ).rejects.toThrow("prepared statement failed");

    expect(calls).toEqual([
      "exec:SET FOREIGN_KEY_CHECKS = 0",
      "tx:begin",
      "tx:set @fragno_db_system_migration_stmt = 'select 1'",
      "tx:prepare fragno_db_system_migration_stmt from @fragno_db_system_migration_stmt",
      "tx:execute fragno_db_system_migration_stmt",
      "tx:deallocate prepare fragno_db_system_migration_stmt",
      "exec:SET FOREIGN_KEY_CHECKS = 1",
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
