import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { KyselyAdapter } from "./kysely-adapter";
import { column, idColumn, schema } from "../../schema/create";

describe("KyselyAdapter PGLite", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"));
      })
      .alterTable("users", (t) => {
        return t
          .createIndex("unique_email", ["email"], { unique: true })
          .addColumn("age", column("integer").nullable());
      });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kysely: Kysely<any>;
  let adapter: KyselyAdapter;

  beforeAll(async () => {
    const { dialect } = await KyselyPGlite.create();
    kysely = new Kysely({
      dialect,
    });

    adapter = new KyselyAdapter({
      db: kysely,
      provider: "postgresql",
    });
  });

  it("should run migrations and basic queries", { timeout: 10000 }, async () => {
    const schemaVersion = await adapter.getSchemaVersion("test");
    expect(schemaVersion).toBeUndefined();

    const migrator = adapter.createMigrationEngine(testSchema, "test");
    const preparedMigration = await migrator.prepareMigration();
    assert(preparedMigration.getSQL);

    await preparedMigration.execute();
    expect(preparedMigration.getSQL()).toMatchInlineSnapshot(`
      "create table "users" ("id" varchar(30) not null primary key, "name" text not null, "email" text not null);

      alter table "users" add column "age" integer;

      create unique index "unique_email" on "users" ("email");

      create table "fragno_db_settings" ("key" varchar(255) primary key, "value" text not null);

      insert into "fragno_db_settings" ("key", "value") values ('test.schema_version', '2');"
    `);

    const queryEngine = adapter.createQueryEngine(testSchema, "test");
    const insertResult = await queryEngine.create("users", {
      name: "John Doe",
      email: "john.doe@example.com",
    });

    expect(insertResult).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{20,}$/),
      name: "John Doe",
      email: "john.doe@example.com",
      age: null,
    });

    await queryEngine.updateMany("users", {
      where: (b) => b("id", "=", insertResult["id"]),
      set: {
        name: "Jane Doe",
      },
    });

    const queryResult = await queryEngine.findMany("users");
    expect(queryResult).toEqual([
      {
        id: insertResult["id"],
        name: "Jane Doe",
        email: "john.doe@example.com",
        age: null,
      },
    ]);
  });
});
