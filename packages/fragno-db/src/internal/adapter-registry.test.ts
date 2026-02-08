import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { getRegistryForAdapterSync } from "./adapter-registry";

describe("adapter registry", () => {
  it("returns the same registry for the same adapter instance", async () => {
    const sqlite = new SQLite(":memory:");
    const adapter = new SqlAdapter({
      dialect: new SqliteDialect({ database: sqlite }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const registryA = getRegistryForAdapterSync(adapter);
    const registryB = getRegistryForAdapterSync(adapter);

    expect(registryA).toBe(registryB);
    expect(registryA.internalFragment).toBeTruthy();

    await adapter.close();
    sqlite.close();
  });

  it("keeps registries isolated across adapter instances", async () => {
    const sqliteA = new SQLite(":memory:");
    const adapterA = new SqlAdapter({
      dialect: new SqliteDialect({ database: sqliteA }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const sqliteB = new SQLite(":memory:");
    const adapterB = new SqlAdapter({
      dialect: new SqliteDialect({ database: sqliteB }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const registryA = getRegistryForAdapterSync(adapterA);
    const registryB = getRegistryForAdapterSync(adapterB);

    registryA.registerSchema(
      {
        name: "alpha",
        namespace: "alpha",
        version: 1,
        tables: ["alpha_items"],
      },
      { name: "alpha-fragment", mountRoute: "/alpha" },
    );

    expect(registryA.listSchemas()).toHaveLength(1);
    expect(registryB.listSchemas()).toHaveLength(0);

    await adapterA.close();
    await adapterB.close();
    sqliteA.close();
    sqliteB.close();
  });
});
