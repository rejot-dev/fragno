import { DummyDriver, PostgresAdapter, SqliteAdapter } from "kysely";
import { describe, expect, beforeAll, test } from "vitest";
import { KyselyAdapter } from "../kysely-adapter";
import { column, idColumn, referenceColumn, schema } from "../../../schema/create";
import {
  BetterSQLite3DriverConfig,
  NodePostgresDriverConfig,
} from "../../generic-sql/driver-config";

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

  let adapter: KyselyAdapter;

  beforeAll(async () => {
    adapter = new KyselyAdapter({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createQueryCompiler: () => ({
          compileQuery: () => ({
            sql: "",
            parameters: [],
          }),
        }),
      },
      driverConfig: new NodePostgresDriverConfig(),
    });
  });

  test("generate SQL for migration 0 -> 1 (create users table)", async () => {
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test_namespace");
    const compiledMigration = preparedMigrations.compile(0, 1, { updateVersionInMigration: true });

    expect(compiledMigration.statements.length).toBeGreaterThan(0);
    const sql = preparedMigrations.getSQL(0, 1, { updateVersionInMigration: true });
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test_namespace" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      insert into "fragno_db_settings" ("id", "key", "value") values ('jprP_43K5uMwxAFiepbbrQ', 'test_namespace.schema_version', '1');"
    `);
  });

  test("generate SQL for migration 0 -> 2 (create users table and add age)", async () => {
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test_namespace");
    const compiledMigration = preparedMigrations.compile(0, 2, { updateVersionInMigration: true });

    expect(compiledMigration.statements.length).toBeGreaterThan(0);
    const sql = preparedMigrations.getSQL(0, 2, { updateVersionInMigration: true });
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test_namespace" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      alter table "users_test_namespace" add column "age" integer;

      create index "name_idx_users_test_namespace" on "users_test_namespace" ("name");

      create index "age_idx_users_test_namespace" on "users_test_namespace" ("age");

      insert into "fragno_db_settings" ("id", "key", "value") values ('jprP_43K5uMwxAFiepbbrQ', 'test_namespace.schema_version', '2');"
    `);
  });

  test("generate SQL for migration 1 -> 2 (add age column and indexes)", async () => {
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test_namespace");
    const compiledMigration = preparedMigrations.compile(1, 2, { updateVersionInMigration: true });

    expect(compiledMigration.statements.length).toBeGreaterThan(0);
    const sql = preparedMigrations.getSQL(1, 2, { updateVersionInMigration: true });
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "alter table "users_test_namespace" add column "age" integer;

      create index "name_idx_users_test_namespace" on "users_test_namespace" ("name");

      create index "age_idx_users_test_namespace" on "users_test_namespace" ("age");

      update "fragno_db_settings" set "value" = '2' where "key" = 'test_namespace.schema_version';"
    `);
  });

  test("generate SQL for migration 0 -> 3 (full schema)", async () => {
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test_namespace");
    const compiledMigration = preparedMigrations.compile(0, 3, { updateVersionInMigration: true });

    expect(compiledMigration.statements.length).toBeGreaterThan(0);
    const sql = preparedMigrations.getSQL(0, 3, { updateVersionInMigration: true });
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test_namespace" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      alter table "users_test_namespace" add column "age" integer;

      create index "name_idx_users_test_namespace" on "users_test_namespace" ("name");

      create index "age_idx_users_test_namespace" on "users_test_namespace" ("age");

      create table "posts_test_namespace" ("id" varchar(30) not null unique, "title" text not null, "user_id" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      insert into "fragno_db_settings" ("id", "key", "value") values ('jprP_43K5uMwxAFiepbbrQ', 'test_namespace.schema_version', '3');"
    `);
  });

  test("generate SQL for migration 2 -> 3 (add posts table)", async () => {
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test_namespace");
    const compiledMigration = preparedMigrations.compile(2, 3, { updateVersionInMigration: true });

    expect(compiledMigration.statements.length).toBeGreaterThan(0);
    const sql = preparedMigrations.getSQL(2, 3, { updateVersionInMigration: true });
    expect(sql).toBeDefined();
    expect(sql).toMatchInlineSnapshot(`
      "create table "posts_test_namespace" ("id" varchar(30) not null unique, "title" text not null, "user_id" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      update "fragno_db_settings" set "value" = '3' where "key" = 'test_namespace.schema_version';"
    `);
  });

  test("generate empty SQL for migration 2 -> 2 (no changes)", async () => {
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test_namespace");
    const compiledMigration = preparedMigrations.compile(2, 2, { updateVersionInMigration: true });

    expect(compiledMigration.statements.length).toBe(0);
    const sql = preparedMigrations.getSQL(2, 2, { updateVersionInMigration: true });
    expect(sql).toBe("");
  });

  test("throw error for backward migration", async () => {
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test_namespace");

    expect(() => preparedMigrations.compile(2, 1, { updateVersionInMigration: true })).toThrow(
      "Cannot migrate backwards",
    );
  });

  test("throw error for version beyond schema", async () => {
    const preparedMigrations = adapter.prepareMigrations(testSchema, "test_namespace");

    expect(() => preparedMigrations.compile(0, 10, { updateVersionInMigration: true })).toThrow(
      "exceeds schema version",
    );
  });
});

describe("KyselyMigrator - SQLite Foreign Key Merging", () => {
  // Test the user's exact example schema
  const userExampleSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t.addColumn("id", idColumn());
      })
      .addTable("posts", (t) => {
        return t.addColumn("id", idColumn()).addColumn("authorId", referenceColumn());
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "authorId" },
        to: { table: "users", column: "id" },
      });
  });

  let adapter: KyselyAdapter;

  beforeAll(async () => {
    // Create a Kysely instance with SQLite dialect
    adapter = new KyselyAdapter({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new DummyDriver(),
        createQueryCompiler: () => ({
          compileQuery: () => ({
            sql: "",
            parameters: [],
          }),
        }),
      },
      driverConfig: new BetterSQLite3DriverConfig(),
    });
  });

  test("SQLite should merge foreign keys into create-table operations", async () => {
    const preparedMigrations = adapter.prepareMigrations(userExampleSchema, "test");

    // Migrate from 0 -> 3 (all tables + FK in one batch)
    const compiledMigration = preparedMigrations.compile(0, 3, { updateVersionInMigration: true });

    expect(compiledMigration.statements.length).toBeGreaterThan(0);
    const sql = preparedMigrations.getSQL(0, 3, { updateVersionInMigration: true });
    expect(sql).toBeDefined();

    // The SQL should have PRAGMA defer_foreign_keys
    expect(sql).toContain("PRAGMA defer_foreign_keys = ON");

    // Should create users table
    expect(sql).toContain('create table "users_test"');

    // Should create posts table WITH inline foreign key constraint
    expect(sql).toContain('create table "posts_test"');
    expect(sql).toContain("foreign key");
    expect(sql).toContain("authorId");
    expect(sql).toContain('references "users_test"');

    // Should NOT have a separate ALTER TABLE ADD FOREIGN KEY
    // (SQLite doesn't support it, and we've merged it into create-table)
    expect(sql).not.toMatch(/alter table.*add.*foreign key/i);
  });

  test("SQLite FK merging full schema verification", async () => {
    const preparedMigrations = adapter.prepareMigrations(userExampleSchema, "test");

    const sql = preparedMigrations.getSQL(0, 3, { updateVersionInMigration: true });
    expect(sql).toBeDefined();

    // Verify the complete SQL snapshot
    expect(sql).toMatchInlineSnapshot(`
      "PRAGMA defer_foreign_keys = ON;

      create table "users_test" ("id" text not null unique, "_internalId" integer not null primary key autoincrement, "_version" integer default 0 not null);

      create table "posts_test" ("id" text not null unique, "authorId" integer not null, "_internalId" integer not null primary key autoincrement, "_version" integer default 0 not null, constraint "posts_users_author_fk" foreign key ("authorId") references "users_test" ("_internalId") on delete restrict on update restrict);

      insert into "fragno_db_settings" ("id", "key", "value") values ('BflimUWc1NbCMMDD9SM3gQ', 'test.schema_version', '3');"
    `);
  });
});
