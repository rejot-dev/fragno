import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { assert, describe, expect, it } from "vitest";
import { KyselyAdapter } from "./kysely-adapter";
import { column, idColumn, schema } from "../../schema/create";

const testSchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn().defaultTo("auto"))
        .addColumn("name", column("string"))
        .addColumn("email", column("string"));
    })
    .alterTable("users", (t) => {
      return t
        .createIndex("unique_email", ["email"], { unique: true })
        .addColumn("age", column("integer").nullable());
    });
});

describe("KyselyAdapter", () => {
  it("should create a migration engine", { timeout: 10000 }, async () => {
    const { dialect } = await KyselyPGlite.create();
    const kysely = new Kysely({
      dialect,
    });

    const adapter = new KyselyAdapter({
      db: kysely,
      provider: "postgresql",
    });

    const schemaVersion = await adapter.getSchemaVersion("test");
    expect(schemaVersion).toBeUndefined();

    const migrator = adapter.createMigrationEngine(testSchema, "test");
    const preparedMigration = await migrator.prepareMigration();
    assert(preparedMigration.getSQL);

    await preparedMigration.execute();
    expect(preparedMigration.getSQL()).toContain("create table");

    const queryEngine = adapter.createQueryEngine(testSchema, "test");
    const insertResult = await queryEngine.create("users", {
      name: "John Doe",
      email: "john.doe@example.com",
    });

    expect(insertResult).toEqual({
      id: expect.any(String),
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
