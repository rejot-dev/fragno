import { describe, expect, it, assert } from "vitest";

import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { getRegistryForAdapterSync } from "./adapter-registry";
import { getOutboxConfigForAdapter } from "./outbox-state";

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
      { outbox: {} },
    );

    expect(registryA.listSchemas()).toHaveLength(1);
    expect(registryB.listSchemas()).toHaveLength(0);

    await adapterA.close();
    await adapterB.close();
    sqliteA.close();
    sqliteB.close();
  });

  it("enables adapter outbox config when a fragment opts in", async () => {
    const sqlite = new SQLite(":memory:");
    const adapter = new SqlAdapter({
      dialect: new SqliteDialect({ database: sqlite }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const outboxConfig = getOutboxConfigForAdapter(adapter);
    assert(!outboxConfig.enabled);

    const registry = getRegistryForAdapterSync(adapter);
    registry.registerSchema(
      {
        name: "alpha",
        namespace: "alpha",
        version: 1,
        tables: ["alpha_items", "alpha_events"],
      },
      { name: "alpha-fragment", mountRoute: "/alpha" },
      { outbox: { tables: ["alpha_items"] } },
    );

    assert(outboxConfig.enabled);
    assert(registry.isOutboxEnabled());
    expect(registry.outboxState.enabledTablesBySchemaKey.get("alpha")).toEqual(
      new Set(["alpha_items"]),
    );

    await adapter.close();
    sqlite.close();
  });

  it("rejects outbox tables that are not part of the fragment schema", async () => {
    const sqlite = new SQLite(":memory:");
    const adapter = new SqlAdapter({
      dialect: new SqliteDialect({ database: sqlite }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    const registry = getRegistryForAdapterSync(adapter);
    expect(() =>
      registry.registerSchema(
        {
          name: "alpha",
          namespace: "alpha",
          version: 1,
          tables: ["alpha_items"],
        },
        { name: "alpha-fragment", mountRoute: "/alpha" },
        { outbox: { tables: ["missing"] } },
      ),
    ).toThrow("Cannot enable outbox for unknown table(s) in schema 'alpha': missing.");
    expect(registry.listSchemas()).toEqual([]);
    expect(registry.listOutboxFragments()).toEqual([]);

    await adapter.close();
    sqlite.close();
  });
});
