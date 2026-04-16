import { assert, describe, expect, it } from "vitest";

import { SQLocalKysely } from "sqlocal/kysely";

import { internalSchema } from "../../fragments/internal-fragment";
import { column, idColumn, schema } from "../../schema/create";
import { SQLocalDriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

describe("SqlAdapter", () => {
  const testSchema = schema("test", (s) => {
    return s.addTable("products", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("price", column("integer"))
        .createIndex("name_idx", ["name"]);
    });
  });

  it("Should be able to query using SqlAdapter", async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const driverConfig = new SQLocalDriverConfig();

    const adapter = new SqlAdapter({ dialect, driverConfig });

    // Create settings table first (needed for version tracking)
    const settingsMigrations = adapter.prepareMigrations(internalSchema, "");
    await settingsMigrations.executeWithDriver(adapter.driver, 0);

    // Now run the actual test schema migrations (use a different namespace)
    const migrations = adapter.prepareMigrations(testSchema, "test");
    await migrations.executeWithDriver(adapter.driver, 0);

    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    await (async () => {
      const uow = queryEngine.createUnitOfWork("write");
      const created = uow.create("products", {
        name: "test",
        price: 100,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      return created;
    })();

    const product = await (async () => {
      const uow = queryEngine
        .createUnitOfWork("read")
        .findFirst("products", (b) => b.whereIndex("name_idx", (eb) => eb("name", "=", "test")));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

    assert(product);
    expect(product.name).toBe("test");
    expect(product.price).toBe(100);

    await adapter.close();
  });
});
