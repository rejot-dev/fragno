import { SQLocalKysely } from "sqlocal/kysely";
import { assert, describe, expect, it } from "vitest";
import { SQLocalDriverConfig } from "./driver-config";
import { GenericSQLAdapter } from "./generic-sql-adapter";
import { column, idColumn, schema } from "../../schema/create";
import { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";

describe("GenericSQLAdapter", () => {
  const testSchema = schema((s) => {
    return s.addTable("products", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("price", column("integer"))
        .createIndex("name_idx", ["name"]);
    });
  });

  it("Should be able to query using GenericSQLAdapter", async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const driverConfig = new SQLocalDriverConfig();

    const adapter = new GenericSQLAdapter({ dialect, driverConfig });

    const { compile, execute } = adapter.prepareMigrations(testSchema, "");
    const compiledMigration = compile();
    await execute(new SqlDriverAdapter(dialect), compiledMigration);

    const queryEngine = adapter.createQueryEngine(testSchema, "");

    await queryEngine.create("products", {
      name: "test",
      price: 100,
    });

    const product = await queryEngine.findFirst("products", (b) =>
      b.whereIndex("name_idx", (eb) => eb("name", "=", "test")),
    );

    assert(product);
    expect(product.name).toBe("test");
    expect(product.price).toBe(100);

    await adapter.close();
  });
});
