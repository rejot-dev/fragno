import { Kysely, PostgresDialect } from "kysely";
import { describe, expect, beforeAll, test } from "vitest";
import { KyselyAdapter } from "../kysely-adapter";
import { column, idColumn, schema } from "../../../schema/create";

describe("KyselyMigrator", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      })
      .alterTable("users", (t) => {
        return t
          .addColumn("age", column("integer").nullable())
          .createIndex("name_idx", ["name"])
          .createIndex("age_idx", ["age"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("user_id", column("string"));
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "user_id" },
        to: { table: "users", column: "id" },
      });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: Kysely<any>;
  let adapter: KyselyAdapter;

  beforeAll(async () => {
    // Create a Kysely instance with a PostgresDialect, but not actually connected to a database
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new Kysely({ dialect: new PostgresDialect({} as any) });
    adapter = new KyselyAdapter({ db, provider: "postgresql" });
  });

  test("generate SQL for migration 0 -> 1 (create users table)", async () => {
    const migrator = adapter.createMigrationEngine(testSchema, "test_namespace");
    const preparedMigration = await migrator.prepareMigrationTo(1, {
      updateSettings: true,
      fromVersion: 0,
    });

    expect(preparedMigration.operations.length).toBeGreaterThan(0);
    const sql = preparedMigration.getSQL?.();
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test_namespace" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      insert into "fragno_db_settings" ("id", "key", "value") values ('jprP_43K5uMwxAFiepbbrQ', 'test_namespace.schema_version', '1');"
    `);
  });

  test("generate SQL for migration 0 -> 2 (create users table and add age)", async () => {
    const migrator = adapter.createMigrationEngine(testSchema, "test_namespace");
    const preparedMigration = await migrator.prepareMigrationTo(2, {
      updateSettings: true,
      fromVersion: 0,
    });

    expect(preparedMigration.operations.length).toBeGreaterThan(0);
    const sql = preparedMigration.getSQL?.();
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test_namespace" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      alter table "users_test_namespace" add column "age" integer;

      create index "name_idx" on "users_test_namespace" ("name");

      create index "age_idx" on "users_test_namespace" ("age");

      insert into "fragno_db_settings" ("id", "key", "value") values ('jprP_43K5uMwxAFiepbbrQ', 'test_namespace.schema_version', '2');"
    `);
  });

  test("generate SQL for migration 1 -> 2 (add age column and indexes)", async () => {
    const migrator = adapter.createMigrationEngine(testSchema, "test_namespace");
    const preparedMigration = await migrator.prepareMigrationTo(2, {
      updateSettings: true,
      fromVersion: 1,
    });

    expect(preparedMigration.operations.length).toBeGreaterThan(0);
    const sql = preparedMigration.getSQL?.();
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "alter table "users_test_namespace" add column "age" integer;

      create index "name_idx" on "users_test_namespace" ("name");

      create index "age_idx" on "users_test_namespace" ("age");

      update "fragno_db_settings" set "value" = '2' where "key" = 'test_namespace.schema_version';"
    `);
  });

  test("generate SQL for migration 0 -> 3 (full schema)", async () => {
    const migrator = adapter.createMigrationEngine(testSchema, "test_namespace");
    const preparedMigration = await migrator.prepareMigrationTo(3, {
      updateSettings: true,
      fromVersion: 0,
    });

    expect(preparedMigration.operations.length).toBeGreaterThan(0);
    const sql = preparedMigration.getSQL?.();
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test_namespace" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      alter table "users_test_namespace" add column "age" integer;

      create index "name_idx" on "users_test_namespace" ("name");

      create index "age_idx" on "users_test_namespace" ("age");

      create table "posts_test_namespace" ("id" varchar(30) not null unique, "title" text not null, "user_id" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      insert into "fragno_db_settings" ("id", "key", "value") values ('jprP_43K5uMwxAFiepbbrQ', 'test_namespace.schema_version', '3');"
    `);
  });

  test("generate SQL for migration 2 -> 3 (add posts table)", async () => {
    const migrator = adapter.createMigrationEngine(testSchema, "test_namespace");
    const preparedMigration = await migrator.prepareMigrationTo(3, {
      updateSettings: true,
      fromVersion: 2,
    });

    expect(preparedMigration.operations.length).toBeGreaterThan(0);
    const sql = preparedMigration.getSQL?.();
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "create table "posts_test_namespace" ("id" varchar(30) not null unique, "title" text not null, "user_id" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      update "fragno_db_settings" set "value" = '3' where "key" = 'test_namespace.schema_version';"
    `);
  });

  test("generate empty SQL for migration 2 -> 2 (no changes)", async () => {
    const migrator = adapter.createMigrationEngine(testSchema, "test_namespace");
    const preparedMigration = await migrator.prepareMigrationTo(2, {
      updateSettings: true,
      fromVersion: 2,
    });

    expect(preparedMigration.operations.length).toBe(0);
    const sql = preparedMigration.getSQL?.();
    expect(sql).toBeDefined();
    expect(sql).toBe("");
  });

  test("throw error for backward migration", async () => {
    const migrator = adapter.createMigrationEngine(testSchema, "test_namespace");

    await expect(
      migrator.prepareMigrationTo(1, {
        updateSettings: true,
        fromVersion: 2,
      }),
    ).rejects.toThrow("Cannot migrate backwards");
  });

  test("throw error for version beyond schema", async () => {
    const migrator = adapter.createMigrationEngine(testSchema, "test_namespace");

    await expect(
      migrator.prepareMigrationTo(10, {
        updateSettings: true,
        fromVersion: 0,
      }),
    ).rejects.toThrow("schema only has version 4");
  });
});
