import { afterAll, beforeAll, describe, expect, it } from "vitest";

import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";

import { BetterSQLite3DriverConfig } from "./adapters/generic-sql/driver-config";
import { SqlAdapter } from "./adapters/generic-sql/generic-sql-adapter";
import { getDurableHooksService } from "./durable-hooks";
import { internalSchema } from "./fragments/internal-fragment";
import { getInternalFragment } from "./internal/adapter-registry";
import { schema, column, idColumn } from "./schema/create";
import { withDatabase } from "./with-database";

const testSchema = schema("test", (s) =>
  s.addTable("items", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const testFragmentDefinition = defineFragment("test")
  .extend(withDatabase(testSchema))
  .provideHooks(({ defineHook }) => ({
    onTest: defineHook(async function () {}),
  }))
  .build();

describe("getDurableHooksService", () => {
  let baseAdapter: SqlAdapter;
  let hookAdapter: SqlAdapter;

  beforeAll(async () => {
    const baseDb = new SQLite(":memory:");
    const hookDb = new SQLite(":memory:");

    baseAdapter = new SqlAdapter({
      dialect: new SqliteDialect({ database: baseDb }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    hookAdapter = new SqlAdapter({
      dialect: new SqliteDialect({ database: hookDb }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    (
      baseAdapter as SqlAdapter & { getHookProcessingAdapter?: () => SqlAdapter }
    ).getHookProcessingAdapter = () => hookAdapter;

    const baseInternalMigrations = baseAdapter.prepareMigrations(internalSchema, null);
    await baseInternalMigrations.executeWithDriver(baseAdapter.driver, 0);

    const hookInternalMigrations = hookAdapter.prepareMigrations(internalSchema, null);
    await hookInternalMigrations.executeWithDriver(hookAdapter.driver, 0);

    const testMigrations = baseAdapter.prepareMigrations(testSchema, "test");
    await testMigrations.executeWithDriver(baseAdapter.driver, 0);
  }, 12000);

  afterAll(async () => {
    await baseAdapter.close();
    await hookAdapter.close();
  });

  it("uses the hook processing adapter when reading durable hooks", () => {
    const fragment = instantiate(testFragmentDefinition)
      .withConfig({})
      .withOptions({ databaseAdapter: baseAdapter })
      .build();

    const { hookService, hooksEnabled, namespace } = getDurableHooksService(fragment);

    const baseInternal = getInternalFragment(baseAdapter);
    const hookInternal = getInternalFragment(hookAdapter);

    expect(hooksEnabled).toBe(true);
    expect(namespace).toBe("test");
    expect(hookService).toBe(hookInternal.services.hookService);
    expect(hookService).not.toBe(baseInternal.services.hookService);
  });
});
