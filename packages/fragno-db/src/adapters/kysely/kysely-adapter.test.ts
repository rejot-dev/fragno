import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { assert, describe, expect, it } from "vitest";
import { KyselyAdapter } from "./kysely-adapter";
import { column, idColumn, schema } from "../../schema/create";

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

describe("KyselyAdapter", () => {
  it("should create a migration engine", async () => {
    const { dialect } = await KyselyPGlite.create();
    const kysely = new Kysely({
      dialect,
    });

    const adapter = new KyselyAdapter({
      db: kysely,
      provider: "postgresql",
      namespace: "test",
    });

    const schemaVersion = await adapter.getSchemaVersion();
    expect(schemaVersion).toBeUndefined();

    const migrator = adapter.createMigrationEngine(testSchema);
    const result = await migrator.migrate();
    // expect(result.operations).toHaveLength(3);
    assert(result.getSQL);
    expect(result.getSQL()).toContain("create table");
    // console.log(result.getSQL());
  });
});
