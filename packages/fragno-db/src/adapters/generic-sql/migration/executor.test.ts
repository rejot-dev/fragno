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

  it("skips sqlite shard backfill when _shard already exists", async () => {
    await adapter.executeQuery(CompiledQuery.raw('create table "sharded_table" ("_shard" text)'));

    const migration: CompiledMigration = {
      fromVersion: 0,
      toVersion: 1,
      statements: [CompiledQuery.raw('alter table "sharded_table" add column "_shard" text')],
    };

    await expect(executeMigration(adapter, migration, { databaseType: "sqlite" })).resolves.toBe(
      undefined,
    );
  });
});
